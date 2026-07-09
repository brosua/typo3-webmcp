<?php

declare(strict_types=1);

namespace Brosua\Webmcp\ViewHelpers\Form;

use TYPO3\CMS\Form\Domain\Model\Renderable\RootRenderableInterface;
use TYPO3Fluid\Fluid\Core\ViewHelper\AbstractViewHelper;

/**
 * Builds the WebMCP declarative tool attributes (`toolname`, `tooldescription`,
 * `toolautosubmit`) for the root EXT:form `<form>` tag.
 *
 * The root form element is a FormDefinition and does NOT support `properties` /
 * `fluidAdditionalAttributes` (FormDefinition::setOptions() only allows
 * rendererClassName, renderingOptions, finishers, formEditor, label, variants).
 * The declarative attributes are therefore configured in a
 * `renderingOptions.webmcp` block and turned into an `additionalAttributes`
 * array here, used by the overridden frontend Form template.
 *
 *   renderingOptions:
 *     webmcp:
 *       toolname: contact
 *       tooldescription: 'Send us a message'
 *       autosubmit: true
 */
final class ToolAttributesViewHelper extends AbstractViewHelper
{
    protected $escapeOutput = false;

    public function initializeArguments(): void
    {
        $this->registerArgument('form', 'object', 'The form runtime (root renderable).', true);
    }

    /**
     * @return array<string, string>
     */
    public function render(): array
    {
        $form = $this->arguments['form'];
        if (!$form instanceof RootRenderableInterface) {
            return [];
        }

        $webmcp = $form->getRenderingOptions()['webmcp'] ?? null;
        if (!is_array($webmcp)) {
            return [];
        }

        $toolName = trim((string)($webmcp['toolname'] ?? ''));
        if ($toolName === '') {
            return [];
        }

        $attributes = ['toolname' => $toolName];

        $description = trim((string)($webmcp['tooldescription'] ?? ''));
        if ($description !== '') {
            $attributes['tooldescription'] = $description;
        }

        if (!empty($webmcp['autosubmit'])) {
            // Boolean attribute: any value makes hasAttribute('toolautosubmit') true.
            $attributes['toolautosubmit'] = 'toolautosubmit';
        }

        return $attributes;
    }
}
