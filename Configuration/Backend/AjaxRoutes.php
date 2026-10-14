<?php

use Brosua\Webmcp\Controller\PageInfoController;
use Brosua\Webmcp\Controller\RecordFieldsController;

return [
    'webmcp_page_info' => [
        'path' => '/webmcp/page-info',
        'target' => PageInfoController::class . '::infoAction',
    ],
    'webmcp_record_fields' => [
        'path' => '/webmcp/record-fields',
        'methods' => ['POST'],
        'target' => RecordFieldsController::class . '::fieldsAction',
    ],
];
