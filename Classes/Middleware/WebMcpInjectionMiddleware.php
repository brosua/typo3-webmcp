<?php

declare(strict_types=1);

namespace Brosua\Webmcp\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use TYPO3\CMS\Core\Page\AssetCollector;

/**
 * Registers the client-side WebMCP bootstrap module via the TYPO3 AssetCollector.
 * The actual tool registration happens in the browser via document.modelContext
 * (see Resources/Public/JavaScript/webmcp.js).
 *
 * This is an experimental proof of concept.
 */
final class WebMcpInjectionMiddleware implements MiddlewareInterface
{
    public function __construct(
        private readonly AssetCollector $assetCollector,
    ) {}

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $this->assetCollector->addJavaScript(
            'webmcp',
            'EXT:webmcp/Resources/Public/JavaScript/webmcp.js',
            ['type' => 'module'],
        );

        return $handler->handle($request);
    }
}
