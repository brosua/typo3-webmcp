<?php

declare(strict_types=1);

namespace Brosua\Webmcp\ViewHelpers\Form;

use TYPO3\CMS\Form\Domain\Model\Renderable\RootRenderableInterface;
use TYPO3Fluid\Fluid\Core\ViewHelper\AbstractViewHelper;

/**
 * Builds the WebMCP declarative tool attributes (`toolname`, `tooldescription`)
 * for the root EXT:form `<form>` tag. `toolautosubmit` is never rendered: the
 * visitor always submits the form.
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
 */
final class ToolAttributesViewHelper extends AbstractViewHelper
{
    // Browsers reject other tool names (WebMCP registerTool()).
    private const TOOL_NAME_PATTERN = '/^[A-Za-z0-9_.-]{1,128}$/';

    protected $escapeOutput = false;

    public function initializeArguments(): void
    {
        $this->registerArgument('form', 'object', 'The form runtime (root renderable).', true);
        $this->registerArgument('attributes', 'mixed', 'Attributes the core template renders on the form tag; the tool attributes are merged into them.', false, []);
    }

    /**
     * @return array<string, string>
     */
    public function render(): array
    {
        $attributes = is_array($this->arguments['attributes']) ? $this->arguments['attributes'] : [];

        $form = $this->arguments['form'];
        if (!$form instanceof RootRenderableInterface) {
            return $attributes;
        }

        $webmcp = $form->getRenderingOptions()['webmcp'] ?? null;
        if (!is_array($webmcp)) {
            return $attributes;
        }

        $toolName = trim((string)($webmcp['toolname'] ?? ''));
        if (!preg_match(self::TOOL_NAME_PATTERN, $toolName)) {
            return $attributes;
        }

        $attributes['toolname'] = $toolName;

        $description = trim((string)($webmcp['tooldescription'] ?? ''));
        if ($description !== '') {
            $attributes['tooldescription'] = $description;
        }

        return $attributes;
    }
}
