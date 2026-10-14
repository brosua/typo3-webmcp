<?php

declare(strict_types=1);

namespace Brosua\Webmcp\EventListener;

use TYPO3\CMS\Backend\Controller\Event\AfterBackendPageRenderEvent;
use TYPO3\CMS\Backend\Routing\UriBuilder;
use TYPO3\CMS\Core\Attribute\AsEventListener;
use TYPO3\CMS\Core\Authentication\BackendUserAuthentication;
use TYPO3\CMS\Core\Page\PageRenderer;
use TYPO3\CMS\Core\Schema\TcaSchemaFactory;
use TYPO3\CMS\Core\Utility\GeneralUtility;

/**
 * Loads the backend WebMCP tools into the main backend document, which stays
 * loaded while modules change in the content frame.
 *
 * User TSconfig (the tools are off unless enabled):
 *   options.webmcp.enableBackendTools = 1
 *   options.webmcp.prepareRecordTables = pages,tt_content
 */
final readonly class LoadBackendTools
{
    private const DEFAULT_PREPARE_RECORD_TABLES = 'pages,tt_content';

    public function __construct(
        private PageRenderer $pageRenderer,
        private UriBuilder $uriBuilder,
        private TcaSchemaFactory $tcaSchemaFactory,
    ) {}

    #[AsEventListener(identifier: 'brosua/webmcp/load-backend-tools')]
    public function __invoke(AfterBackendPageRenderEvent $event): void
    {
        $backendUser = $GLOBALS['BE_USER'] ?? null;
        if (!$backendUser instanceof BackendUserAuthentication) {
            return;
        }
        $options = $backendUser->getTSConfig()['options.']['webmcp.'] ?? [];
        if (empty($options['enableBackendTools'])) {
            return;
        }

        $tables = GeneralUtility::trimExplode(',', (string)($options['prepareRecordTables'] ?? self::DEFAULT_PREPARE_RECORD_TABLES), true);
        $tables = array_values(array_filter(
            $tables,
            fn(string $table): bool => $this->tcaSchemaFactory->has($table) && $backendUser->check('tables_modify', $table)
        ));

        $this->pageRenderer->addInlineSetting('WebMcp', 'backend', [
            'recordEditUrl' => (string)$this->uriBuilder->buildUriFromRoute('record_edit'),
            'prepareRecordTables' => $tables,
        ]);
        $this->pageRenderer->loadJavaScriptModule('@brosua/webmcp/backend-tools.js');
    }
}
