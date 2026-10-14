<?php

declare(strict_types=1);

namespace Brosua\Webmcp\Controller;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use TYPO3\CMS\Backend\Attribute\AsController;
use TYPO3\CMS\Backend\Utility\BackendUtility;
use TYPO3\CMS\Core\Authentication\BackendUserAuthentication;
use TYPO3\CMS\Core\Http\JsonResponse;
use TYPO3\CMS\Core\Type\Bitmask\Permission;

/**
 * Tells the backend tools whether a page exists and the editor may create
 * records of the given table on it.
 */
#[AsController]
final readonly class PageInfoController
{
    public function infoAction(ServerRequestInterface $request): ResponseInterface
    {
        $uid = (int)($request->getQueryParams()['uid'] ?? 0);
        $table = (string)($request->getQueryParams()['table'] ?? '');
        $backendUser = $GLOBALS['BE_USER'] ?? null;
        if ($uid <= 0 || !$backendUser instanceof BackendUserAuthentication) {
            return new JsonResponse(['found' => false]);
        }
        // A new page needs PAGE_NEW on its parent, any other record CONTENT_EDIT on its page.
        $permission = $table === 'pages' ? Permission::PAGE_NEW : Permission::CONTENT_EDIT;
        $page = BackendUtility::readPageAccess($uid, $backendUser->getPagePermsClause($permission));
        if (!is_array($page) || (int)($page['uid'] ?? 0) !== $uid) {
            return new JsonResponse(['found' => false]);
        }
        return new JsonResponse([
            'found' => true,
            'uid' => $uid,
            'title' => BackendUtility::getRecordTitle('pages', $page),
        ]);
    }
}
