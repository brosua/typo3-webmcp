<?php

declare(strict_types=1);

namespace Brosua\Webmcp\Event;

use Psr\Http\Message\ServerRequestInterface;

/**
 * PSR-14 event dispatched by the injection middleware right before the
 * `#webmcp-config` JSON is serialized into the page.
 *
 * Listeners may:
 *  - toggle built-in features or any config value per request/site/user
 *    ({@see self::setConfig()});
 *  - queue additional client-side JS modules that register their own WebMCP
 *    tools ({@see self::addModule()}). Each entry is an `EXT:` path that the
 *    middleware resolves and injects as a `<script type="module">` right after
 *    the core module, so the modules can hook into the `webmcp:ready` event.
 *
 * Register listeners with the PHP attribute (no Services.yaml needed):
 *
 * ```php
 * final class MyWebMcpTools
 * {
 *     #[\TYPO3\CMS\Core\Attribute\AsEventListener('my-ext/webmcp')]
 *     public function __invoke(ModifyWebMcpConfigEvent $event): void
 *     {
 *         $event->addModule('EXT:my_ext/Resources/Public/JavaScript/webmcp-tools.js');
 *     }
 * }
 * ```
 */
final class ModifyWebMcpConfigEvent
{
    /**
     * @param array<string, mixed> $config Serialized into #webmcp-config (debug, features, submitForms, ...)
     * @param list<string> $additionalModules EXT: paths to additional JS modules
     */
    public function __construct(
        private array $config,
        private array $additionalModules,
        private readonly ServerRequestInterface $request,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function getConfig(): array
    {
        return $this->config;
    }

    /**
     * @param array<string, mixed> $config
     */
    public function setConfig(array $config): void
    {
        $this->config = $config;
    }

    /**
     * @return list<string>
     */
    public function getAdditionalModules(): array
    {
        return $this->additionalModules;
    }

    /**
     * Queue an additional client-side JS module (ES module) that registers its
     * own WebMCP tools once `webmcp:ready` fires.
     *
     * @param string $extPath e.g. "EXT:my_ext/Resources/Public/JavaScript/webmcp-tools.js"
     */
    public function addModule(string $extPath): void
    {
        if ($extPath !== '' && !in_array($extPath, $this->additionalModules, true)) {
            $this->additionalModules[] = $extPath;
        }
    }

    public function getRequest(): ServerRequestInterface
    {
        return $this->request;
    }
}
