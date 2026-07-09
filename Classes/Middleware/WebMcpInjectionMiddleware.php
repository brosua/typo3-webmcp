<?php

declare(strict_types=1);

namespace Brosua\Webmcp\Middleware;

use Brosua\Webmcp\Event\ModifyWebMcpConfigEvent;
use Psr\EventDispatcher\EventDispatcherInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Psr\Log\LoggerAwareInterface;
use Psr\Log\LoggerAwareTrait;
use TYPO3\CMS\Core\Http\NormalizedParams;
use TYPO3\CMS\Core\Page\AssetCollector;
use TYPO3\CMS\Core\Utility\GeneralUtility;

/**
 * Registers the client-side WebMCP bootstrap (module + JSON config)
 * via the TYPO3 AssetCollector. The actual tool registration happens in the
 * browser via document.modelContext (see Resources/Public/JavaScript/webmcp.js).
 *
 * Assets are registered BEFORE the inner handler renders the page, because the
 * AssetCollector is consumed by the PageRenderer during rendering. Delegating
 * to the AssetCollector gives us cache-busting URLs, deduplication by identifier
 * and CSP nonce handling for free.
 *
 * This is an experimental proof of concept.
 */
final class WebMcpInjectionMiddleware implements MiddlewareInterface, LoggerAwareInterface
{
    use LoggerAwareTrait;

    public function __construct(
        private readonly EventDispatcherInterface $eventDispatcher,
        private readonly AssetCollector $assetCollector,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        // WebMCP requires a secure context. Skip injection over plain HTTP unless
        // the host is a local development host (localhost/127.0.0.1/*.localhost).
        if ($this->isSecureContext($request)) {
            // Register before rendering so the PageRenderer picks the assets up.
            $this->registerAssets($request);
        }

        return $handler->handle($request);
    }

    private function isSecureContext(ServerRequestInterface $request): bool
    {
        $normalizedParams = $request->getAttribute('normalizedParams');
        if ($normalizedParams instanceof NormalizedParams && $normalizedParams->isHttps()) {
            return true;
        }

        $host = $normalizedParams instanceof NormalizedParams
            ? $normalizedParams->getHttpHost()
            : $request->getUri()->getHost();
        $host = strtolower((string)preg_replace('/:\d+$/', '', (string)$host));

        return $host === 'localhost'
            || $host === '127.0.0.1'
            || $host === '[::1]'
            || $host === '::1'
            || str_ends_with($host, '.localhost');
    }

    private function registerAssets(ServerRequestInterface $request): void
    {
        $clientConfig = [
            'features' => [
                'content' => true,
            ],
        ];

        // Let integrations tweak the client config and queue their own JS tool
        // modules per request/site/user without touching this extension.
        $event = $this->eventDispatcher->dispatch(
            new ModifyWebMcpConfigEvent($clientConfig, [], $request)
        );
        $clientConfig = $event->getConfig();
        $additionalModules = $event->getAdditionalModules();

        try {
            $jsonConfig = json_encode(
                $clientConfig,
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            );
        } catch (\JsonException $e) {
            // A listener may have injected non-serializable values via setConfig().
            // Skip injection instead of letting the whole frontend response fail.
            $this->logger?->error(
                'WebMCP: client config could not be encoded, skipping injection.',
                ['exception' => $e]
            );
            return;
        }
        // json_encode already produces safe content for a JSON script block, but
        // guard the closing tag defensively.
        $jsonConfig = str_replace('</', '<\/', $jsonConfig);

        // Config as a JSON island in <head> (priority) so it is present in the
        // DOM before the deferred module executes and reads #webmcp-config.
        $this->assetCollector->addInlineJavaScript(
            'webmcp-config',
            $jsonConfig,
            ['type' => 'application/json', 'id' => 'webmcp-config'],
            ['priority' => true]
        );

        // Main module. type=module scripts are deferred, so they run after
        // #webmcp-config is available.
        $this->assetCollector->addJavaScript(
            'webmcp',
            'EXT:webmcp/Resources/Public/JavaScript/webmcp.js',
            ['type' => 'module']
        );

        // Additional per-request tool modules contributed by integrations.
        foreach ($additionalModules as $extPath) {
            $absolute = GeneralUtility::getFileAbsFileName($extPath);
            if ($absolute === '' || !is_file($absolute)) {
                continue;
            }
            $this->assetCollector->addJavaScript(
                'webmcp-module-' . md5($extPath),
                $extPath,
                ['type' => 'module']
            );
        }
    }
}
