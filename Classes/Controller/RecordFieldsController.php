<?php

declare(strict_types=1);

namespace Brosua\Webmcp\Controller;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use TYPO3\CMS\Backend\Attribute\AsController;
use TYPO3\CMS\Backend\Form\Exception as FormException;
use TYPO3\CMS\Backend\Form\FormDataCompiler;
use TYPO3\CMS\Backend\Form\FormDataGroup\TcaDatabaseRecord;
use TYPO3\CMS\Core\Authentication\BackendUserAuthentication;
use TYPO3\CMS\Core\Http\JsonResponse;
use TYPO3\CMS\Core\Schema\TcaSchemaFactory;
use TYPO3\CMS\Core\Utility\GeneralUtility;

/**
 * Tells backend-prepare-record which fields the new-record form shows to the
 * editor, so no value can be prefilled that the editor would not see.
 *
 * The form data is compiled like FormEngine does it, so access rights, TCAdefaults,
 * TCEFORM, authMode, allowed page types and displayCond are respected.
 */
#[AsController]
final readonly class RecordFieldsController
{
    public function __construct(
        private TcaSchemaFactory $tcaSchemaFactory,
        private FormDataCompiler $formDataCompiler,
    ) {}

    public function fieldsAction(ServerRequestInterface $request): ResponseInterface
    {
        $body = (array)$request->getParsedBody();
        $table = (string)($body['table'] ?? '');
        $pageUid = (int)($body['pageUid'] ?? 0);
        $values = array_map(strval(...), array_filter(is_array($body['values'] ?? null) ? $body['values'] : [], is_scalar(...)));
        $backendUser = $GLOBALS['BE_USER'] ?? null;
        if (!$backendUser instanceof BackendUserAuthentication || $pageUid <= 0 || !$this->tcaSchemaFactory->has($table)) {
            return $this->error(sprintf('Records of "%s" cannot be created.', $table));
        }

        $schema = $this->tcaSchemaFactory->get($table);
        $typeField = null;
        $unknownType = null;
        if ($schema->supportsSubSchema()) {
            $typeInformation = $schema->getSubSchemaTypeInformation();
            if ($typeInformation->isPointerToForeignFieldInForeignSchema()) {
                return $this->error(sprintf('The form of "%s" depends on a related record and cannot be prefilled.', $table));
            }
            $typeField = $typeInformation->getFieldName();
            if (isset($values[$typeField]) && !$schema->hasSubSchema($values[$typeField])) {
                $unknownType = $values[$typeField];
                unset($values[$typeField]);
            }
        }

        try {
            $formData = $this->formDataCompiler->compile([
                'request' => $request,
                'tableName' => $table,
                'vanillaUid' => $pageUid,
                'command' => 'new',
                'defaultValues' => [$table => $values],
            ], GeneralUtility::makeInstance(TcaDatabaseRecord::class));
        } catch (FormException) {
            return $this->error(sprintf('The editor may not create records of "%s" on page %d.', $table, $pageUid));
        }

        $type = (string)$formData['recordTypeValue'];
        if ($typeField !== null) {
            // Select processing drops values the editor may not choose (authMode, removeItems, page types).
            $selected = $formData['databaseRow'][$typeField] ?? null;
            $isAllowed = !is_array($selected) || in_array($type, array_map(strval(...), $selected), true);
            if ($unknownType !== null || !$isAllowed) {
                $items = $formData['processedTca']['columns'][$typeField]['config']['items'] ?? [];
                // A value the editor may not choose is listed as "invalid value" item.
                $allowed = array_diff(array_map(strval(...), array_column($items, 'value')), $isAllowed ? ['--div--'] : ['--div--', $type]);
                return $this->invalidType($unknownType ?? $type, $typeField, $table, $allowed);
            }
        }

        return new JsonResponse([
            'typeField' => $typeField,
            'type' => $typeField !== null ? $type : null,
            'fields' => $this->visibleFields($formData, $backendUser, (string)($formData['processedTca']['types'][$type]['showitem'] ?? '')),
        ]);
    }

    /**
     * @param array<string, mixed> $formData
     * @return list<string>
     */
    private function visibleFields(array $formData, BackendUserAuthentication $backendUser, string $showitem): array
    {
        $table = $formData['tableName'];
        $fields = [];
        foreach (GeneralUtility::trimExplode(',', $showitem, true) as $item) {
            [$name, , $palette] = GeneralUtility::trimExplode(';', $item . ';;;');
            if ($name === '--palette--') {
                $paletteConfiguration = $formData['processedTca']['palettes'][$palette] ?? [];
                if (empty($paletteConfiguration['isHiddenPalette'])) {
                    array_push($fields, ...$this->visibleFields($formData, $backendUser, (string)($paletteConfiguration['showitem'] ?? '')));
                }
                continue;
            }
            // Same checks as SingleFieldContainer; fields failing their displayCond are already removed.
            $column = $formData['processedTca']['columns'][$name] ?? null;
            if (is_array($column)
                && (empty($column['exclude']) || $backendUser->check('non_exclude_fields', $table . ':' . $name))
                && empty($formData['pageTsConfig']['TCEFORM.'][$table . '.'][$name . '.']['disabled'])
            ) {
                $fields[] = $name;
            }
        }
        return $fields;
    }

    /**
     * @param array<string> $allowed
     */
    private function invalidType(string $type, string $typeField, string $table, array $allowed): ResponseInterface
    {
        return $this->error(sprintf(
            '"%s" is no %s the editor may choose for %s. Valid values: %s.',
            $type,
            $typeField,
            $table,
            implode(', ', $allowed)
        ));
    }

    private function error(string $message): ResponseInterface
    {
        return new JsonResponse(['error' => $message]);
    }
}
