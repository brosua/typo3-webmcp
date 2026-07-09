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
use TYPO3\CMS\Core\Configuration\ExtensionConfiguration;
use TYPO3\CMS\Core\Configuration\Exception\ExtensionConfigurationExtensionNotConfiguredException;
use TYPO3\CMS\Core\Configuration\Exception\ExtensionConfigurationPathDoesNotExistException;
use TYPO3\CMS\Core\Http\NormalizedParams;
use TYPO3\CMS\Core\Page\AssetCollector;
use TYPO3\CMS\Core\SystemResource\Publishing\SystemResourcePublisherInterface;
use TYPO3\CMS\Core\SystemResource\SystemResourceFactory;
use TYPO3\CMS\Core\Utility\GeneralUtility;

/**
 * Registers the client-side WebMCP bootstrap (module + JSON config + debug CSS)
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
        private readonly ExtensionConfiguration $extensionConfiguration,
        private readonly SystemResourceFactory $systemResourceFactory,
        private readonly SystemResourcePublisherInterface $resourcePublisher,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $config = $this->resolveConfig();

        // WebMCP requires a secure context. Skip injection over plain HTTP unless
        // the host is a local development host (localhost/127.0.0.1/*.localhost).
        if ($this->isSecureContext($request)) {
            // Register before rendering so the PageRenderer picks the assets up.
            $this->registerAssets($config, $request);
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

    /**
     * @return array{debug: bool, submitForms: bool}
     */
    private function resolveConfig(): array
    {
        return [
            'debug' => $this->getBoolConfig('debug', false),
            'submitForms' => $this->getBoolConfig('submitForms', false),
        ];
    }

    private function getBoolConfig(string $path, bool $default): bool
    {
        try {
            return (bool)$this->extensionConfiguration->get('webmcp', $path);
        } catch (ExtensionConfigurationExtensionNotConfiguredException | ExtensionConfigurationPathDoesNotExistException) {
            return $default;
        }
    }

    /**
     * @param array{debug: bool, submitForms: bool} $config
     */
    private function registerAssets(array $config, ServerRequestInterface $request): void
    {
        $clientConfig = [
            'debug' => $config['debug'],
            'features' => [
                'forms' => true,
                'content' => true,
            ],
            'submitForms' => $config['submitForms'],
            'adaptersUrl' => $this->resolvePublicUri('EXT:webmcp/Resources/Public/JavaScript/forms/adapters.js', $request),
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

        // Debug/overlay stylesheet (always rendered in <head>).
        $this->assetCollector->addStyleSheet(
            'webmcp',
            'EXT:webmcp/Resources/Public/Css/webmcp-debug.css'
        );

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

    /**
     * Resolves an EXT: path to its published, cache-busted public URL using the
     * same mechanism the AssetRenderer uses for script tags. The main module is
     * cache-busted by the AssetCollector, but its static sub-imports (e.g.
     * forms/adapters.js) are not, so integrators would otherwise receive a stale
     * sub-module after an update. The resolved URL is handed to the client config
     * and imported dynamically.
     */
    private function resolvePublicUri(string $extPath, ServerRequestInterface $request): string
    {
        $resource = $this->systemResourceFactory->createPublicResource($extPath);
        return (string)$this->resourcePublisher->generateUri($resource, $request);
    }
}
