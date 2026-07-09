<?php

$EM_CONF[$_EXTKEY] = [
    'title' => 'TYPO3 WebMCP',
    'description' => 'WebMCP integration: exposes TYPO3 forms and content as in-browser AI-agent tools.',
    'category' => 'fe',
    'author' => 'Josua Vogel',
    'author_email' => 'j.vogel97@web.de',
    'state' => 'alpha',
    'version' => '0.1.0',
    'constraints' => [
        'depends' => [
            'typo3' => '14.3.0-14.99.99',
        ],
        'conflicts' => [],
        'suggests' => [
            'form' => '',
        ],
    ],
    'autoload' => [
        'psr-4' => [
            'Brosua\\Webmcp\\' => 'Classes/',
        ],
    ],
];
