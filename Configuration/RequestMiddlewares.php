<?php

return [
    'frontend' => [
        'brosua/webmcp/injection' => [
            'target' => \Brosua\Webmcp\Middleware\WebMcpInjectionMiddleware::class,
            'after' => [
                'typo3/cms-frontend/site',
            ],
        ],
    ],
];
