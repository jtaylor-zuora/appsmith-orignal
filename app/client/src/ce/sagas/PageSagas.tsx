import type { AppState } from "@appsmith/reducers";
import type {
  Page,
  ReduxAction,
  UpdateCanvasPayload,
} from "@appsmith/constants/ReduxActionConstants";
import {
  ReduxActionErrorTypes,
  ReduxActionTypes,
} from "@appsmith/constants/ReduxActionConstants";
import type {
  ClonePageActionPayload,
  CreatePageActionPayload,
} from "actions/pageActions";
import { createPage, fetchPublishedPage } from "actions/pageActions";
import {
  clonePageSuccess,
  deletePageSuccess,
  fetchAllPageEntityCompletion,
  fetchPage,
  fetchPageSuccess,
  fetchPublishedPageSuccess,
  generateTemplateError,
  generateTemplateSuccess,
  initCanvasLayout,
  saveLayout,
  savePageSuccess,
  setLastUpdatedTime,
  setUrlData,
  updateAndSaveLayout,
  updateCurrentPage,
  updatePageError,
  updatePageSuccess,
  updateWidgetNameSuccess,
} from "actions/pageActions";
import type {
  ClonePageRequest,
  CreatePageRequest,
  DeletePageRequest,
  FetchPageRequest,
  FetchPageResponse,
  FetchPageResponseData,
  FetchPublishedPageRequest,
  GenerateTemplatePageRequest,
  PageLayout,
  PageLayoutsRequest,
  SavePageRequest,
  SavePageResponse,
  SavePageResponseData,
  SetPageOrderRequest,
  UpdatePageRequest,
  UpdatePageResponse,
  UpdateWidgetNameRequest,
  UpdateWidgetNameResponse,
} from "api/PageApi";
import PageApi from "api/PageApi";
import type {
  CanvasWidgetsReduxState,
  FlattenedWidgetProps,
} from "reducers/entityReducers/canvasWidgetsReducer";
import { all, call, delay, put, select, take } from "redux-saga/effects";
import history from "utils/history";
import { isNameValid } from "utils/helpers";
import { extractCurrentDSL } from "utils/WidgetPropsUtils";
import {
  getAllPageIds,
  getDefaultPageId,
  getEditorConfigs,
  getWidgets,
} from "sagas/selectors";
import { IncorrectBindingError, validateResponse } from "sagas/ErrorSagas";
import type { ApiResponse } from "api/ApiResponses";
import {
  combinedPreviewModeSelector,
  getCurrentApplicationId,
  getCurrentLayoutId,
  getCurrentPageId,
  getCurrentPageName,
  getMainCanvasProps,
  getPageById,
} from "selectors/editorSelectors";
import {
  executePageLoadActions,
  fetchActionsForPage,
  fetchActionsForPageError,
  fetchActionsForPageSuccess,
  setActionsToExecuteOnPageLoad,
  setJSActionsToExecuteOnPageLoad,
} from "actions/pluginActionActions";
import type { UrlDataState } from "reducers/entityReducers/appReducer";
import { APP_MODE } from "entities/App";
import { clearEvalCache } from "../../sagas/EvaluationsSaga";
import { getQueryParams } from "utils/URLUtils";
import PerformanceTracker, {
  PerformanceTransactionName,
} from "utils/PerformanceTracker";
import log from "loglevel";
import { migrateIncorrectDynamicBindingPathLists } from "utils/migrations/IncorrectDynamicBindingPathLists";
import * as Sentry from "@sentry/react";
import { ERROR_CODES } from "@appsmith/constants/ApiConstants";
import AnalyticsUtil from "@appsmith/utils/AnalyticsUtil";
import DEFAULT_TEMPLATE from "templates/default";

import { getAppMode } from "@appsmith/selectors/applicationSelectors";
import { setCrudInfoModalData } from "actions/crudInfoModalActions";
import { selectWidgetInitAction } from "actions/widgetSelectionActions";
import {
  fetchJSCollectionsForPage,
  fetchJSCollectionsForPageError,
  fetchJSCollectionsForPageSuccess,
} from "actions/jsActionActions";

import WidgetFactory from "WidgetProvider/factory";
import { builderURL } from "@appsmith/RouteBuilder";
import { failFastApiCalls, waitForWidgetConfigBuild } from "sagas/InitSagas";
import { resizePublishedMainCanvasToLowestWidget } from "sagas/WidgetOperationUtils";
import {
  checkAndLogErrorsIfCyclicDependency,
  getFromServerWhenNoPrefetchedResult,
} from "sagas/helper";
import { LOCAL_STORAGE_KEYS } from "utils/localStorage";
import { generateAutoHeightLayoutTreeAction } from "actions/autoHeightActions";
import { getUsedActionNames } from "selectors/actionSelectors";
import { getPageList } from "@appsmith/selectors/entitiesSelector";
import { setPreviewModeAction } from "actions/editorActions";
import { SelectionRequestType } from "sagas/WidgetSelectUtils";
import { toast } from "design-system";
import { getCurrentGitBranch } from "selectors/gitSyncSelectors";
import type { MainCanvasReduxState } from "reducers/uiReducers/mainCanvasReducer";
import { UserCancelledActionExecutionError } from "sagas/ActionExecution/errorUtils";
import { getInstanceId } from "@appsmith/selectors/tenantSelectors";
import { MAIN_CONTAINER_WIDGET_ID } from "constants/WidgetConstants";
import type { WidgetProps } from "widgets/BaseWidget";
import { nestDSL, flattenDSL, LATEST_DSL_VERSION } from "@shared/dsl";
import { fetchSnapshotDetailsAction } from "actions/autoLayoutActions";
import { selectFeatureFlags } from "@appsmith/selectors/featureFlagsSelectors";
import { isGACEnabled } from "@appsmith/utils/planHelpers";
import { getHasManagePagePermission } from "@appsmith/utils/BusinessFeatures/permissionPageHelpers";
import { getLayoutSystemType } from "selectors/layoutSystemSelectors";
import { getLayoutSystemDSLTransformer } from "layoutSystems/common/utils/LayoutSystemDSLTransformer";
import type { DSLWidget } from "WidgetProvider/constants";
import type { FeatureFlags } from "@appsmith/entities/FeatureFlag";
import { getCurrentWorkspaceId } from "@appsmith/selectors/selectedWorkspaceSelectors";
import { ActionExecutionContext } from "entities/Action";
import type { LayoutSystemTypes } from "layoutSystems/types";
import { getIsAnvilLayout } from "layoutSystems/anvil/integrations/selectors";

export const checkIfMigrationIsNeeded = (
  fetchPageResponse?: FetchPageResponse,
) => {
  const currentDSL = fetchPageResponse?.data.layouts[0].dsl;
  if (!currentDSL) return false;
  return currentDSL.version !== LATEST_DSL_VERSION;
};

export const WidgetTypes = WidgetFactory.widgetTypes;

export const getWidgetName = (state: AppState, widgetId: string) =>
  state.entities.canvasWidgets[widgetId];

//Method to load the default page if current page is not found
export function* refreshTheApp() {
  try {
    const currentPageId: string = yield select(getCurrentPageId);
    const defaultPageId: string = yield select(getDefaultPageId);
    const pagesList: Page[] = yield select(getPageList);
    const gitBranch: string = yield select(getCurrentGitBranch);

    const isCurrentPageIdInList =
      pagesList.filter((page) => page.pageId === currentPageId).length > 0;

    if (isCurrentPageIdInList) {
      location.reload();
    } else {
      location.assign(
        builderURL({
          pageId: defaultPageId,
          branch: gitBranch,
        }),
      );
    }
  } catch (error) {
    log.error(error);
    location.reload();
  }
}

export const getCanvasWidgetsPayload = (
  pageResponse: FetchPageResponse,
  dslTransformer?: (dsl: DSLWidget) => DSLWidget,
): UpdateCanvasPayload => {
  const extractedDSL = extractCurrentDSL({
    dslTransformer,
    response: pageResponse,
  }).dsl;
  const flattenedDSL = flattenDSL(extractedDSL);
  const pageWidgetId = MAIN_CONTAINER_WIDGET_ID;
  return {
    pageWidgetId,
    currentPageName: pageResponse.data.name,
    currentPageId: pageResponse.data.id,
    dsl: extractedDSL,
    widgets: flattenedDSL,
    currentLayoutId: pageResponse.data.layouts[0].id, // TODO(abhinav): Handle for multiple layouts
    currentApplicationId: pageResponse.data.applicationId,
    pageActions: pageResponse.data.layouts[0].layoutOnLoadActions || [],
    layoutOnLoadActionErrors:
      pageResponse.data.layouts[0].layoutOnLoadActionErrors || [],
  };
};

export function* handleFetchedPage({
  fetchPageResponse,
  isFirstLoad = false,
  pageId,
}: {
  fetchPageResponse: FetchPageResponse;
  pageId: string;
  isFirstLoad?: boolean;
}) {
  const layoutSystemType: LayoutSystemTypes = yield select(getLayoutSystemType);
  const isAnvilLayout: boolean = yield select(getIsAnvilLayout);
  const mainCanvasProps: MainCanvasReduxState =
    yield select(getMainCanvasProps);
  const dslTransformer = getLayoutSystemDSLTransformer(
    layoutSystemType,
    mainCanvasProps.width,
  );
  const isValidResponse: boolean = yield validateResponse(fetchPageResponse);
  const willPageBeMigrated = checkIfMigrationIsNeeded(fetchPageResponse);
  const lastUpdatedTime = getLastUpdateTime(fetchPageResponse);
  const pageSlug = fetchPageResponse.data.slug;
  const pagePermissions = fetchPageResponse.data.userPermissions;

  if (isValidResponse) {
    // Clear any existing caches
    yield call(clearEvalCache);
    // Set url params
    yield call(setDataUrl);
    // Wait for widget config to be loaded before we can generate the canvas payload
    yield call(waitForWidgetConfigBuild);
    // Get Canvas payload
    const canvasWidgetsPayload = getCanvasWidgetsPayload(
      fetchPageResponse,
      dslTransformer,
    );
    // Update the canvas
    yield put(initCanvasLayout(canvasWidgetsPayload));
    // fetch snapshot API
    yield put(fetchSnapshotDetailsAction());
    // set current page
    yield put(updateCurrentPage(pageId, pageSlug, pagePermissions));
    // dispatch fetch page success
    yield put(fetchPageSuccess());

    /* Currently, All Actions are fetched in initSagas and on pageSwitch we only fetch page
     */
    // Hence, if is not isFirstLoad then trigger evaluation with execute pageLoad action
    if (!isFirstLoad) {
      yield put(fetchAllPageEntityCompletion([executePageLoadActions()]));
    }

    // Sets last updated time
    yield put(setLastUpdatedTime(lastUpdatedTime));

    yield put({
      type: ReduxActionTypes.UPDATE_CANVAS_STRUCTURE,
      payload: canvasWidgetsPayload.dsl,
    });

    // Since new page has new layout, we need to generate a data structure
    // to compute dynamic height based on the new layout.
    yield put(generateAutoHeightLayoutTreeAction(true, true));

    // If the type of the layoutSystem is ANVIL, then we need to save the layout
    // This is because we have updated the DSL
    // using the AnvilDSLTransformer when we called the getCanvasWidgetsPayload function
    if (willPageBeMigrated || isAnvilLayout) {
      yield put(saveLayout());
    }
  }
}

export const getLastUpdateTime = (pageResponse: FetchPageResponse): number =>
  pageResponse.data.lastUpdatedTime;

export function* fetchPageSaga(
  pageRequestAction: ReduxAction<FetchPageRequest>,
) {
  try {
    const { id, isFirstLoad, pageWithMigratedDsl } = pageRequestAction.payload;
    PerformanceTracker.startAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      { pageId: id },
    );

    const params: FetchPageRequest = { id, migrateDSL: true };
    const fetchPageResponse: FetchPageResponse = yield call(
      getFromServerWhenNoPrefetchedResult,
      pageWithMigratedDsl,
      () => call(PageApi.fetchPage, params),
    );

    yield handleFetchedPage({
      fetchPageResponse,
      pageId: id,
      isFirstLoad,
    });

    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
    );
  } catch (error) {
    log.error(error);
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      {
        failed: true,
      },
    );
    yield put({
      type: ReduxActionErrorTypes.FETCH_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* fetchPublishedPageSaga(
  pageRequestAction: ReduxAction<{
    pageId: string;
    bustCache: boolean;
    firstLoad: boolean;
    pageWithMigratedDsl?: FetchPageResponse;
  }>,
) {
  try {
    const { bustCache, firstLoad, pageId, pageWithMigratedDsl } =
      pageRequestAction.payload;
    PerformanceTracker.startAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      {
        pageId: pageId,
        published: true,
      },
    );
    const request: FetchPublishedPageRequest = {
      pageId,
      bustCache,
    };

    const response: FetchPageResponse = yield call(
      getFromServerWhenNoPrefetchedResult,
      pageWithMigratedDsl,
      () => call(PageApi.fetchPublishedPage, request),
    );

    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      // Clear any existing caches
      yield call(clearEvalCache);
      // Set url params
      yield call(setDataUrl);
      // Wait for widget config to load before we can get the canvas payload
      yield call(waitForWidgetConfigBuild);
      // Get Canvas payload
      const canvasWidgetsPayload = getCanvasWidgetsPayload(response);
      // resize main canvas
      resizePublishedMainCanvasToLowestWidget(canvasWidgetsPayload.widgets);
      // Update the canvas
      yield put(initCanvasLayout(canvasWidgetsPayload));
      // set current page
      yield put(
        updateCurrentPage(
          pageId,
          response.data.slug,
          response.data.userPermissions,
        ),
      );

      // dispatch fetch page success
      yield put(fetchPublishedPageSuccess());

      // Since new page has new layout, we need to generate a data structure
      // to compute dynamic height based on the new layout.
      yield put(generateAutoHeightLayoutTreeAction(true, true));

      /* Currently, All Actions are fetched in initSagas and on pageSwitch we only fetch page
       */
      // Hence, if is not isFirstLoad then trigger evaluation with execute pageLoad action
      if (!firstLoad) {
        yield put(fetchAllPageEntityCompletion([executePageLoadActions()]));
      }

      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.FETCH_PAGE_API,
      );
    }
  } catch (error) {
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.FETCH_PAGE_API,
      {
        failed: true,
      },
    );
    yield put({
      type: ReduxActionErrorTypes.FETCH_PUBLISHED_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* fetchAllPublishedPagesSaga() {
  try {
    const pageIds: string[] = yield select(getAllPageIds);
    yield all(
      pageIds.map((pageId: string) => {
        return call(PageApi.fetchPublishedPage, { pageId, bustCache: true });
      }),
    );
  } catch (error) {
    log.error({ error });
  }
}

export function* savePageSaga(action: ReduxAction<{ isRetry?: boolean }>) {
  const widgets: CanvasWidgetsReduxState = yield select(getWidgets);
  const editorConfigs:
    | {
        applicationId: string;
        pageId: string;
        layoutId: string;
      }
    | undefined = yield select(getEditorConfigs) as any;

  if (!editorConfigs) return;

  const savePageRequest: SavePageRequest = getLayoutSavePayload(
    widgets,
    editorConfigs,
  );
  PerformanceTracker.startAsyncTracking(
    PerformanceTransactionName.SAVE_PAGE_API,
    {
      pageId: savePageRequest.pageId,
    },
  );
  try {
    // Store the updated DSL in the pageDSLs reducer
    yield put({
      type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
      payload: {
        pageId: savePageRequest.pageId,
        dsl: savePageRequest.dsl,
        layoutId: savePageRequest.layoutId,
      },
    });

    yield put({
      type: ReduxActionTypes.UPDATE_CANVAS_STRUCTURE,
      payload: savePageRequest.dsl,
    });

    /**
     * TODO: Reactivate the capturing or remove this block
     * once the below issue has been fixed. Commenting to avoid
     * Sentry quota to fill up
     * https://github.com/appsmithorg/appsmith/issues/20744
     */
    // captureInvalidDynamicBindingPath(
    //   nestDSL(widgets),
    // );

    const savePageResponse: SavePageResponse = yield call(
      PageApi.savePage,
      savePageRequest,
    );
    const isValidResponse: boolean = yield validateResponse(savePageResponse);
    if (isValidResponse) {
      const { actionUpdates, messages } = savePageResponse.data;
      // We do not want to show these toasts in guided tour
      // Show toast messages from the server
      if (messages && messages.length) {
        savePageResponse.data.messages.forEach((message) => {
          toast.show(message, {
            kind: "info",
          });
        });
      }
      // Update actions
      if (actionUpdates && actionUpdates.length > 0) {
        const actions = actionUpdates.filter(
          (d) => !d.hasOwnProperty("collectionId"),
        );
        if (actions && actions.length) {
          yield put(setActionsToExecuteOnPageLoad(actions));
        }
        const jsActions = actionUpdates.filter((d) =>
          d.hasOwnProperty("collectionId"),
        );
        if (jsActions && jsActions.length) {
          yield put(setJSActionsToExecuteOnPageLoad(jsActions));
        }
      }
      yield put(setLastUpdatedTime(Date.now() / 1000));
      yield put(savePageSuccess(savePageResponse));
      PerformanceTracker.stopAsyncTracking(
        PerformanceTransactionName.SAVE_PAGE_API,
      );
      checkAndLogErrorsIfCyclicDependency(
        (savePageResponse.data as SavePageResponseData)
          .layoutOnLoadActionErrors,
      );
    }
  } catch (error) {
    PerformanceTracker.stopAsyncTracking(
      PerformanceTransactionName.SAVE_PAGE_API,
      {
        failed: true,
      },
    );

    if (error instanceof UserCancelledActionExecutionError) {
      return;
    }

    yield put({
      type: ReduxActionErrorTypes.SAVE_PAGE_ERROR,
      payload: {
        error,
        show: false,
      },
    });

    if (error instanceof IncorrectBindingError) {
      const { isRetry } = action?.payload;
      const incorrectBindingError = JSON.parse(error.message);
      const { message } = incorrectBindingError;
      if (isRetry) {
        Sentry.captureException(new Error("Failed to correct binding paths"));
        yield put({
          type: ReduxActionErrorTypes.FAILED_CORRECTING_BINDING_PATHS,
          payload: {
            error: {
              message,
              code: ERROR_CODES.FAILED_TO_CORRECT_BINDING,
              crash: true,
            },
          },
        });
      } else {
        // Create a nested structure because the migration needs the children in the dsl form
        const nestedDSL = nestDSL(widgets);
        const correctedWidgets =
          migrateIncorrectDynamicBindingPathLists(nestedDSL);
        // Flatten the widgets because the save page needs it in the flat structure
        const normalizedWidgets = flattenDSL(correctedWidgets);
        AnalyticsUtil.logEvent("CORRECT_BAD_BINDING", {
          error: error.message,
          correctWidget: JSON.stringify(normalizedWidgets),
        });
        yield put(
          updateAndSaveLayout(normalizedWidgets, {
            isRetry: true,
          }),
        );
      }
    }
  }
}

export function* saveAllPagesSaga(pageLayouts: PageLayoutsRequest[]) {
  let response: ApiResponse | undefined;
  try {
    const applicationId: string = yield select(getCurrentApplicationId);
    response = yield PageApi.saveAllPages(applicationId, pageLayouts);

    const isValidResponse: boolean = yield validateResponse(response, false);

    if (isValidResponse) {
      return true;
    } else {
      throw new Error(`Error while saving all pages, ${response?.data}`);
    }
  } catch (error) {
    throw error;
  }
}

export function getLayoutSavePayload(
  widgets: {
    [widgetId: string]: FlattenedWidgetProps;
  },
  editorConfigs: any,
) {
  const nestedDSL = nestDSL(widgets, Object.keys(widgets)[0]);
  return {
    ...editorConfigs,
    dsl: nestedDSL,
  };
}

export function* saveLayoutSaga(action: ReduxAction<{ isRetry?: boolean }>) {
  try {
    const currentPageId: string = yield select(getCurrentPageId);
    const currentPage: Page = yield select(getPageById(currentPageId));
    const isPreviewMode: boolean = yield select(combinedPreviewModeSelector);

    const appMode: APP_MODE | undefined = yield select(getAppMode);

    const featureFlags: FeatureFlags = yield select(selectFeatureFlags);
    const isFeatureEnabled = isGACEnabled(featureFlags);

    if (
      !getHasManagePagePermission(
        isFeatureEnabled,
        currentPage?.userPermissions || [],
      ) &&
      appMode === APP_MODE.EDIT
    ) {
      yield validateResponse({
        status: 403,
        resourceType: "Page",
        resourceId: currentPage.pageId,
      });
    }

    if (appMode === APP_MODE.EDIT && !isPreviewMode) {
      yield put(saveLayout(action.payload.isRetry));
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.SAVE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* createNewPageFromEntity(
  createPageAction: ReduxAction<CreatePageActionPayload>,
) {
  try {
    const layoutSystemType: LayoutSystemTypes =
      yield select(getLayoutSystemType);
    const mainCanvasProps: MainCanvasReduxState =
      yield select(getMainCanvasProps);
    const dslTransformer = getLayoutSystemDSLTransformer(
      layoutSystemType,
      mainCanvasProps.width,
    );

    // This saga is called when creating a new page from the entity explorer
    // In this flow, the server doesn't have a page DSL to return
    // So, the client premptively uses the default page DSL
    // The default page DSL is used and modified using the layout system
    // specific dslTransformer
    const defaultPageLayouts = [
      {
        dsl: extractCurrentDSL({ dslTransformer }).dsl,
        layoutOnLoadActions: [],
      },
    ];

    const { applicationId, name } = createPageAction?.payload || {};

    const workspaceId: string = yield select(getCurrentWorkspaceId);
    const instanceId: string | undefined = yield select(getInstanceId);

    // So far this saga has only done the prep work to create a page
    // It generates and structures the parameters needed for creating a page
    // At the end we call the `createPage` saga that actually calls the API to
    // create a page
    yield put(
      createPage(
        applicationId,
        name,
        defaultPageLayouts,
        workspaceId,
        instanceId,
      ),
    );
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CREATE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}
export function* createPageSaga(
  createPageAction: ReduxAction<CreatePageActionPayload>,
) {
  try {
    const layoutSystemType: LayoutSystemTypes =
      yield select(getLayoutSystemType);
    const mainCanvasProps: MainCanvasReduxState =
      yield select(getMainCanvasProps);
    const dslTransformer = getLayoutSystemDSLTransformer(
      layoutSystemType,
      mainCanvasProps.width,
    );

    const request: CreatePageRequest = createPageAction.payload;
    const response: FetchPageResponse = yield call(PageApi.createPage, request);
    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      yield put({
        type: ReduxActionTypes.CREATE_PAGE_SUCCESS,
        payload: {
          pageId: response.data.id,
          pageName: response.data.name,
          layoutId: response.data.layouts[0].id,
          slug: response.data.slug,
          customSlug: response.data.customSlug,
          userPermissions: response.data.userPermissions,
        },
      });
      // Add this to the page DSLs for entity explorer
      // The dslTransformer may not be necessary for the entity explorer
      // However, we still transform for consistency.
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: response.data.id,
          dsl: extractCurrentDSL({
            dslTransformer,
            response,
          }).dsl,
          layoutId: response.data.layouts[0].id,
        },
      });
      // TODO: Update URL params here
      // route to generate template for new page created
      history.push(
        builderURL({
          pageId: response.data.id,
        }),
      );
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CREATE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* updatePageSaga(action: ReduxAction<UpdatePageRequest>) {
  try {
    const request: UpdatePageRequest = action.payload;

    // to be done in backend
    request.customSlug = request.customSlug?.replaceAll(" ", "-");

    const response: ApiResponse<UpdatePageResponse> = yield call(
      PageApi.updatePage,
      request,
    );
    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      yield put(updatePageSuccess(response.data));
    }
  } catch (error) {
    yield put(
      updatePageError({
        request: action.payload,
        error,
      }),
    );
  }
}

export function* deletePageSaga(action: ReduxAction<DeletePageRequest>) {
  try {
    const request: DeletePageRequest = action.payload;
    const defaultPageId: string = yield select(
      (state: AppState) => state.entities.pageList.defaultPageId,
    );
    if (defaultPageId === request.id) {
      throw Error("Cannot delete the home page.");
    } else {
      const response: ApiResponse = yield call(PageApi.deletePage, request);
      const isValidResponse: boolean = yield validateResponse(response);
      if (isValidResponse) {
        yield put(deletePageSuccess());
      }
      // Remove this page from page DSLs
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: request.id,
          dsl: undefined,
        },
      });
      // Update route params here
      const currentPageId: string = yield select(
        (state: AppState) => state.entities.pageList.currentPageId,
      );
      if (currentPageId === action.payload.id)
        history.push(
          builderURL({
            pageId: defaultPageId,
          }),
        );
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.DELETE_PAGE_ERROR,
      payload: {
        error: { message: (error as Error).message, show: true },
        show: true,
      },
    });
  }
}

export function* clonePageSaga(
  clonePageAction: ReduxAction<ClonePageActionPayload>,
) {
  try {
    const request: ClonePageRequest = clonePageAction.payload;
    const response: FetchPageResponse = yield call(PageApi.clonePage, request);
    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      yield put(
        clonePageSuccess(
          response.data.id,
          response.data.name,
          response.data.layouts[0].id,
          response.data.slug,
        ),
      );
      // Add this to the page DSLs for entity explorer
      // We're not sending the `dslTransformer` to the `extractCurrentDSL` function
      // as this is a clone operation, and any layout system specific
      // updates to the DSL would have already been performed in the original page
      const { dsl, layoutId } = extractCurrentDSL({
        response,
      });
      yield put({
        type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
        payload: {
          pageId: response.data.id,
          dsl,
          layoutId,
        },
      });

      const triggersAfterPageFetch = [
        fetchActionsForPage(response.data.id),
        fetchJSCollectionsForPage(response.data.id),
      ];

      const afterActionsFetch: unknown = yield failFastApiCalls(
        triggersAfterPageFetch,
        [
          fetchActionsForPageSuccess([]).type,
          fetchJSCollectionsForPageSuccess([]).type,
        ],
        [
          fetchActionsForPageError().type,
          fetchJSCollectionsForPageError().type,
        ],
      );

      if (!afterActionsFetch) {
        throw new Error("Failed cloning page");
      }

      yield put(selectWidgetInitAction(SelectionRequestType.Empty));
      yield put(
        fetchAllPageEntityCompletion([
          executePageLoadActions(ActionExecutionContext.CLONE_PAGE),
        ]),
      );

      // TODO: Update URL params here.

      if (!clonePageAction.payload.blockNavigation) {
        history.push(
          builderURL({
            pageId: response.data.id,
          }),
        );
      }
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.CLONE_PAGE_ERROR,
      payload: {
        error,
      },
    });
  }
}

/**
 * this saga do two things
 *
 * 1. Checks if the name of page is conflicting with any used name
 * 2. dispatches a action which triggers a request to update the name
 *
 * @param action
 */
export function* updateWidgetNameSaga(
  action: ReduxAction<{ id: string; newName: string }>,
) {
  try {
    const { widgetName } = yield select(getWidgetName, action.payload.id);
    const layoutId: string | undefined = yield select(getCurrentLayoutId);
    const pageId: string | undefined = yield select(getCurrentPageId);
    const getUsedNames: Record<string, true> = yield select(
      getUsedActionNames,
      "",
    );

    // TODO(abhinav): Why do we need to jump through these hoops just to
    // change the tab name? Figure out a better design to make this moot.
    const tabsObj: Record<
      string,
      {
        id: string;
        widgetId: string;
        label: string;
      }
    > = yield select((state: AppState) => {
      // Check if this widget exists in the canvas widgets
      if (state.entities.canvasWidgets.hasOwnProperty(action.payload.id)) {
        // If it does assign it to a variable
        const widget = state.entities.canvasWidgets[action.payload.id];
        // Check if this widget has a parent in the canvas widgets
        if (
          widget.parentId &&
          state.entities.canvasWidgets.hasOwnProperty(widget.parentId)
        ) {
          // If the parent exists assign it to a variable
          const parent = state.entities.canvasWidgets[widget.parentId];
          // Check if this parent is a TABS_WIDGET
          if (parent.type === WidgetTypes.TABS_WIDGET) {
            // If it is return the tabs property
            return parent.tabsObj;
          }
        }
      }
      // This isn't a tab in a tabs widget so return undefined
      return;
    });

    // If we're trying to update the name of a tab in the TABS_WIDGET
    if (tabsObj !== undefined) {
      const tabs: any = Object.values(tabsObj);
      // Get all canvas widgets
      const stateWidgets: CanvasWidgetsReduxState = yield select(getWidgets);
      // Shallow copy canvas widgets as they're immutable
      const widgets = { ...stateWidgets };
      // Get the parent Id of the tab (canvas widget) whose name we're updating
      const parentId = widgets[action.payload.id].parentId;
      // Update the tabName property of the tab (canvas widget)
      widgets[action.payload.id] = {
        ...widgets[action.payload.id],
        tabName: action.payload.newName,
      };
      // Shallow copy the parent widget so that we can update the properties
      // @ts-expect-error parentId can be undefined
      const parent = { ...widgets[parentId] };
      // Update the tabs property of the parent tabs widget
      const tabToChange = tabs.find(
        (each: any) => each.widgetId === action.payload.id,
      );
      const updatedTab = {
        ...tabToChange,
        label: action.payload.newName,
      };
      parent.tabsObj = {
        ...parent.tabsObj,
        [updatedTab.id]: {
          ...updatedTab,
        },
      };
      // replace the parent widget in the canvas widgets
      // @ts-expect-error parentId can be undefined
      widgets[parentId] = parent;
      // Update and save the new widgets
      //TODO Identify the updated widgets and pass the values
      yield put(updateAndSaveLayout(widgets));
      // Send a update saying that we've successfully updated the name
      yield put(updateWidgetNameSuccess());
    } else {
      // check if name is not conflicting with any
      // existing entity/api/queries/reserved words
      if (isNameValid(action.payload.newName, getUsedNames)) {
        const request: UpdateWidgetNameRequest = {
          newName: action.payload.newName,
          oldName: widgetName,
          // @ts-expect-error: pageId can be undefined
          pageId,
          // @ts-expect-error: layoutId can be undefined
          layoutId,
        };
        const response: UpdateWidgetNameResponse = yield call(
          PageApi.updateWidgetName,
          request,
        );
        const isValidResponse: boolean = yield validateResponse(response);
        if (isValidResponse) {
          // @ts-expect-error: pageId can be undefined
          yield updateCanvasWithDSL(response.data, pageId, layoutId);
          yield put(updateWidgetNameSuccess());
          // Add this to the page DSLs for entity explorer
          yield put({
            type: ReduxActionTypes.FETCH_PAGE_DSL_SUCCESS,
            payload: {
              pageId: pageId,
              dsl: response.data.dsl,
              layoutId,
            },
          });
          checkAndLogErrorsIfCyclicDependency(
            (response.data as PageLayout).layoutOnLoadActionErrors,
          );
        }
      } else {
        yield put({
          type: ReduxActionErrorTypes.UPDATE_WIDGET_NAME_ERROR,
          payload: {
            error: {
              message: `Entity name: ${action.payload.newName} is already being used or is a restricted keyword.`,
            },
          },
        });
      }
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.UPDATE_WIDGET_NAME_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* updateCanvasWithDSL(
  data: PageLayout & { dsl: WidgetProps },
  pageId: string,
  layoutId: string,
) {
  const flattenedDSL = flattenDSL(data.dsl);
  const currentPageName: string = yield select(getCurrentPageName);

  const applicationId: string = yield select(getCurrentApplicationId);
  const pageWidgetId = MAIN_CONTAINER_WIDGET_ID;
  const canvasWidgetsPayload: UpdateCanvasPayload = {
    pageWidgetId,
    currentPageName,
    currentPageId: pageId,
    currentLayoutId: layoutId,
    currentApplicationId: applicationId,
    dsl: data.dsl,
    pageActions: data.layoutOnLoadActions,
    widgets: flattenedDSL,
  };
  yield put(initCanvasLayout(canvasWidgetsPayload));
  yield put(fetchActionsForPage(pageId));
  yield put(fetchJSCollectionsForPage(pageId));
}

export function* setDataUrl() {
  const urlData: UrlDataState = {
    fullPath: window.location.href,
    host: window.location.host,
    hostname: window.location.hostname,
    queryParams: getQueryParams(),
    protocol: window.location.protocol,
    pathname: window.location.pathname,
    port: window.location.port,
    hash: window.location.hash,
  };
  yield put(setUrlData(urlData));
}

export function* fetchPageDSLSaga(
  pageId: string,
  pageDSL?: ApiResponse<FetchPageResponseData>,
) {
  try {
    const layoutSystemType: LayoutSystemTypes =
      yield select(getLayoutSystemType);
    const mainCanvasProps: MainCanvasReduxState =
      yield select(getMainCanvasProps);
    const dslTransformer = getLayoutSystemDSLTransformer(
      layoutSystemType,
      mainCanvasProps.width,
    );
    const params: FetchPageRequest = { id: pageId, migrateDSL: true };
    const fetchPageResponse: FetchPageResponse = yield call(
      getFromServerWhenNoPrefetchedResult,
      pageDSL,
      () => call(PageApi.fetchPage, params),
    );

    const isValidResponse: boolean = yield validateResponse(fetchPageResponse);
    if (isValidResponse) {
      // Wait for the Widget config to be loaded before we can migrate the DSL
      yield call(waitForWidgetConfigBuild);
      // DSL migrations will now happen on the server
      // So, it may not be necessary to run dslTransformer on the pageDSL
      // or to run the DSL by the extractCurrentDSL function
      // Another caveat to note is that we have conversions happening
      // between Auto Layout and Fixed layout systems, this means that
      // particularly for these two layout systems the dslTransformer may be necessary
      // unless we're no longer running any conversions
      const { dsl, layoutId } = extractCurrentDSL({
        dslTransformer,
        response: fetchPageResponse,
      });
      return {
        pageId,
        dsl,
        layoutId,
        userPermissions: fetchPageResponse.data?.userPermissions,
      };
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.FETCH_PAGE_DSL_ERROR,
      payload: {
        pageId: pageId,
        error,
        show: true,
      },
    });
    return {
      pageId: pageId,
      dsl: DEFAULT_TEMPLATE,
    };
  }
}

export function* populatePageDSLsSaga(action?: {
  payload?: { pagesWithMigratedDsl?: ApiResponse<FetchPageResponseData[]> };
}) {
  const { pagesWithMigratedDsl } = action?.payload || {};
  try {
    const pageIds: string[] = yield select((state: AppState) =>
      state.entities.pageList.pages.map((page: Page) => page.pageId),
    );
    const pageDSLs: unknown = yield all(
      pageIds.map((pageId: string) => {
        if (!pagesWithMigratedDsl) {
          return call(fetchPageDSLSaga, pageId);
        }
        const { data } = pagesWithMigratedDsl;
        const v1PageDSL = data?.find?.((v: any) => v?.id === pageId);
        return call(fetchPageDSLSaga, pageId, {
          ...pagesWithMigratedDsl,
          data: v1PageDSL,
        } as ApiResponse<FetchPageResponseData>);
      }),
    );
    yield put({
      type: ReduxActionTypes.FETCH_PAGE_DSLS_SUCCESS,
      payload: pageDSLs,
    });
    yield put({
      type: ReduxActionTypes.UPDATE_PAGE_LIST,
      payload: pageDSLs,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.POPULATE_PAGEDSLS_ERROR,
      payload: {
        error,
      },
    });
  }
}

/**
 * saga to update the page order
 *
 * @param action
 */
export function* setPageOrderSaga(action: ReduxAction<SetPageOrderRequest>) {
  try {
    const request: SetPageOrderRequest = action.payload;
    const response: ApiResponse = yield call(PageApi.setPageOrder, request);
    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      yield put({
        type: ReduxActionTypes.SET_PAGE_ORDER_SUCCESS,
        payload: {
          // @ts-expect-error: response.data is of type unknown
          pages: response.data.pages,
        },
      });
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.SET_PAGE_ORDER_ERROR,
      payload: {
        error,
      },
    });
  }
}

export function* generateTemplatePageSaga(
  action: ReduxAction<GenerateTemplatePageRequest>,
) {
  try {
    const request: GenerateTemplatePageRequest = action.payload;
    // if pageId is available in request, it will just update that page else it will generate new page.
    const response: ApiResponse<{
      page: any;
      successImageUrl: string;
      successMessage: string;
    }> = yield call(PageApi.generateTemplatePage, request);

    const isValidResponse: boolean = yield validateResponse(response);
    if (isValidResponse) {
      const pageId = response.data.page.id;

      yield put(
        generateTemplateSuccess({
          page: response.data.page,
          isNewPage: !request.pageId,
          // if pageId if not defined, that means a new page is generated.
        }),
      );

      yield handleFetchedPage({
        fetchPageResponse: {
          data: response.data.page,
          responseMeta: response.responseMeta,
        },
        pageId,
        isFirstLoad: true,
      });

      yield put(fetchPage(pageId));

      // trigger evaluation after completion of page success & fetch actions for page + fetch jsobject for page

      const triggersAfterPageFetch = [
        fetchActionsForPage(pageId),
        fetchJSCollectionsForPage(pageId),
      ];

      const afterActionsFetch: unknown = yield failFastApiCalls(
        triggersAfterPageFetch,
        [
          fetchActionsForPageSuccess([]).type,
          fetchJSCollectionsForPageSuccess([]).type,
        ],
        [
          fetchActionsForPageError().type,
          fetchJSCollectionsForPageError().type,
        ],
      );

      if (!afterActionsFetch) {
        throw new Error("Failed generating template");
      }
      yield put(
        fetchAllPageEntityCompletion([
          executePageLoadActions(ActionExecutionContext.GENERATE_CRUD_PAGE),
        ]),
      );

      history.replace(
        builderURL({
          pageId,
        }),
      );
      // TODO : Add it to onSuccessCallback
      toast.show("Successfully generated a page", {
        kind: "success",
      });

      yield put(
        setCrudInfoModalData({
          open: true,
          generateCRUDSuccessInfo: {
            successImageUrl: response.data.successImageUrl,
            successMessage: response.data.successMessage,
          },
        }),
      );
    }
  } catch (error) {
    yield put(generateTemplateError());
  }
}

export function* deleteCanvasCardsStateSaga() {
  const currentPageId: string = yield select(getCurrentPageId);
  const state = JSON.parse(
    localStorage.getItem(LOCAL_STORAGE_KEYS.CANVAS_CARDS_STATE) ?? "{}",
  );
  delete state[currentPageId];
  localStorage.setItem(
    LOCAL_STORAGE_KEYS.CANVAS_CARDS_STATE,
    JSON.stringify(state),
  );
}

export function* setCanvasCardsStateSaga(action: ReduxAction<string>) {
  const state = localStorage.getItem(LOCAL_STORAGE_KEYS.CANVAS_CARDS_STATE);
  const stateObject = JSON.parse(state ?? "{}");
  stateObject[action.payload] = true;
  localStorage.setItem(
    LOCAL_STORAGE_KEYS.CANVAS_CARDS_STATE,
    JSON.stringify(stateObject),
  );
}

export function* setPreviewModeInitSaga(action: ReduxAction<boolean>) {
  const currentPageId: string = yield select(getCurrentPageId);
  const isPreviewMode: boolean = yield select(combinedPreviewModeSelector);
  if (action.payload) {
    // we animate out elements and then move to the canvas
    yield put(setPreviewModeAction(action.payload));
    history.push(
      builderURL({
        pageId: currentPageId,
      }),
    );
  } else if (isPreviewMode) {
    // check if already in edit mode, then only do this

    // when switching back to edit mode
    // we go back to the previous route e.g query, api etc.
    history.goBack();
    // small delay to wait for the content to render and then animate
    yield delay(10);
    yield put(setPreviewModeAction(action.payload));
  }
}

export function* setupPageSaga(action: ReduxAction<FetchPageRequest>) {
  try {
    const { id, isFirstLoad, pageWithMigratedDsl } = action.payload;

    /*
      Added the first line for isPageSwitching redux state to be true when page is being fetched to fix scroll position issue.
      Added the second line for sync call instead of async (due to first line) as it was leading to issue with on page load actions trigger.
    */
    yield put(fetchPage(id, isFirstLoad, pageWithMigratedDsl));
    yield take(ReduxActionTypes.FETCH_PAGE_SUCCESS);

    yield put({
      type: ReduxActionTypes.SETUP_PAGE_SUCCESS,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.SETUP_PAGE_ERROR,
      payload: { error },
    });
  }
}

export function* setupPublishedPageSaga(
  action: ReduxAction<{
    pageId: string;
    bustCache: boolean;
    firstLoad: boolean;
    pageWithMigratedDsl?: FetchPageResponse;
  }>,
) {
  try {
    const { bustCache, firstLoad, pageId, pageWithMigratedDsl } =
      action.payload;

    /*
      Added the first line for isPageSwitching redux state to be true when page is being fetched to fix scroll position issue.
      Added the second line for sync call instead of async (due to first line) as it was leading to issue with on page load actions trigger.
    */
    yield put(
      fetchPublishedPage(pageId, bustCache, firstLoad, pageWithMigratedDsl),
    );
    yield take(ReduxActionTypes.FETCH_PUBLISHED_PAGE_SUCCESS);

    yield put({
      type: ReduxActionTypes.SETUP_PUBLISHED_PAGE_SUCCESS,
    });
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.SETUP_PUBLISHED_PAGE_ERROR,
      payload: { error },
    });
  }
}
