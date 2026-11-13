// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx at 62319b8.
// Adapted from opendatahub-io/odh-dashboard
// packages/maas/frontend/src/app/pages/subscriptions/createSubscription/CreateSubscriptionForm.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The console adds the Organization field: required on create, kept on edit. Telemetry is dropped.
// It writes Subscriptions/Create and Update over Connect.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ActionGroup,
  Alert,
  Button,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  NumberInput,
  TextInput,
  Tooltip,
} from '@patternfly/react-core';
import { create, toJson, type MessageInitShape } from '@bufbuild/protobuf';
import { z } from '../../../validation/zod';
import { describeError } from '../../../api/connect/errors';
import { SYSTEM_AUTHENTICATED_GROUP } from '../../../api/types';
import { AddModelsModal } from '../../../components/AddModelsModal';
import { listOf } from '../../../notifications/writeText';
import { K8sNameDescriptionField } from '../../../components/K8sNameDescriptionField/K8sNameDescriptionField';
import { isK8sNameDescriptionDataValid } from '../../../components/K8sNameDescriptionField/nameField';
import { useK8sNameDescriptionFieldData } from '../../../components/K8sNameDescriptionField/useK8sNameDescriptionFieldData';
import { MaasModelsSection, type SubscriptionModelRow } from '../../../components/MaasModelsSection';
import type { SelectionOptions } from '../../../components/MultiSelection';
import { MultiSelection } from '../../../components/MultiSelection';
import { SystemAuthenticatedWarning } from '../../../components/SystemAuthenticatedWarning';
import { TypeaheadSelect } from '../../../components/TypeaheadSelect';
import {
  SubscriptionModelRefSchema,
  type SubscriptionModelRef,
  SubscriptionSchema,
  SubscriptionSpecSchema,
  type Subscription,
} from '../../../gen/ai_grid/v1/subscription_type_pb';
import type { SubscriptionsGetResponse } from '../../../gen/ai_grid/v1/subscriptions_service_pb';
import { useConfirmDiscard } from '../../../hooks/useConfirmDiscard';
import { formatLocaleNumber } from '../../../utilities/format';
import { getSectionUrl } from '../../../utilities/maasGovernanceNavigation';
import { fieldErrorsOf } from '../../../validation';
import type { SubscriptionModelEntry } from '../hooks/useSubscriptionModels';
import { entryKey, entryModelId, useSubscriptionModels } from '../hooks/useSubscriptionModels';
import {
  descriptionOf,
  groupsOf,
  modelForRef,
  isOrganizationMissing,
  modelRefsOf,
  organizationIdOf,
  refTitleOf,
  registrationStatusOf,
  tenantNameOf,
  toTokenLimits,
  MISSING_ORGANIZATION,
  missingOrganizationReason,
} from '../subscriptionText';
import { DESCRIPTION, DISPLAY_NAME, displayNameOf, type ModelView } from '../../models/modelView';
import { useOrganizations, useSubscriptionWrites } from '../useSubscriptions';
import { useClusterList } from '../../clusters/useClusters';
import { ModelStatusModal } from '../../models/ModelStatusModal';
import { hasPartialModelStatus } from '../partialModelStatus';
import { EditRateLimitsModal } from './EditRateLimitsModal';

type Props = {
  /**
   * The models the form starts with: on an edit, those the subscription's refs name (Models/List
   * filtered by their ids); on a create, every model. The picker loads every model when it opens.
   */
  models: ModelView[];
  /** The subscription being edited, as Subscriptions/Get answered it; none on create. */
  subscriptionInfo?: SubscriptionsGetResponse;
  /**
   * On create: a subscription the backend refused after the form had left, as it was sent, and the
   * refusal; the form starts from it, with the refusal as its error.
   */
  draft?: { subscription: Subscription; error: string };
  returnTo?: string;
};

const MAX_PRIORITY = 1000000;
const MIN_PRIORITY = -1000000;
const PRIORITY_RANGE = `Enter a number from ${formatLocaleNumber(MIN_PRIORITY)} to ${formatLocaleNumber(MAX_PRIORITY)}.`;
const SELECT_ORGANIZATION = 'Select an organization';
/** The field error, a sentence; the placeholder above is a prompt and has no period. */
const ORGANIZATION_REQUIRED = 'Select an organization.';
/**
 * The longest subscription id the form sends: 63 less the managed policy's "-policy" suffix, less
 * the "-" and six characters a backend that makes names unique adds (backend PR 89,
 * internal/servers/subscription_mapper.go). An existing subscription keeps its id.
 */
const MAX_ID_LENGTH = 49;
/** On create: the name sent may not be the subscription's name (backend PR 89). */
const NAME_SUFFIX_HELP = 'The AI grid backend may add a short suffix to the resource name to make it unique.';

const subscriptionFormSchema = z.object({
  priority: z
    .number({ error: 'Required' })
    .int('Enter a whole number.')
    .min(MIN_PRIORITY, PRIORITY_RANGE)
    .max(MAX_PRIORITY, PRIORITY_RANGE),
  groups: z.array(z.string()).min(1, 'Add at least one group.'),
  models: z.array(z.unknown()).min(1, 'Add at least one model.'),
});

const buildInitialModels = (from: Subscription, models: ModelView[], saved: boolean): SubscriptionModelEntry[] =>
  modelRefsOf(from).map((ref) => ({
    ref,
    model: modelForRef(models, ref),
    saved,
    unlimited: ref.unlimited,
    tokenRateLimits: toTokenLimits(ref.tokenRateLimits),
  }));

/**
 * The ref the form writes: the loaded ref's own fields (its namespace, billing rate and guardrails)
 * with the limits set here. The output-only display_name, description and model_id are left out:
 * the backend ignores them on write.
 */
const refPayload = (entry: SubscriptionModelEntry): SubscriptionModelRef =>
  create(SubscriptionModelRefSchema, {
    name: entry.ref.name,
    namespace: entry.ref.namespace,
    billingRate: entry.ref.billingRate,
    guardrails: entry.ref.guardrails,
    unlimited: entry.unlimited,
    tokenRateLimits: entry.tokenRateLimits.map(({ limit, window }) => ({ limit: BigInt(limit), window })),
  });

const errorText = (message: string) => (
  <FormHelperText>
    <HelperText>
      <HelperTextItem variant="error">{message}</HelperTextItem>
    </HelperText>
  </FormHelperText>
);

export const CreateSubscriptionForm: React.FC<Props> = ({
  models: availableModels,
  subscriptionInfo,
  returnTo,
  draft,
}) => {
  const navigate = useNavigate();
  const { data: clusters } = useClusterList();
  const [statusModelId, setStatusModelId] = useState<string>();
  const [pickerFocusModelId, setPickerFocusModelId] = useState<string>();
  const statusModel = availableModels.find((model) => model.id === statusModelId);
  const { data: organizations, known: organizationsKnown, error: organizationsError } = useOrganizations();
  const { createSubscription, updateSubscription } = useSubscriptionWrites();
  const isEditing = !!subscriptionInfo?.object;
  const subscription = subscriptionInfo?.object;
  // What the fields start from: the subscription being edited, or a refused create's draft.
  const initial = subscription ?? draft?.subscription;

  const { data: nameDescData, onDataChange: onNameDescChange } = useK8sNameDescriptionFieldData(
    initial
      ? {
          initialData: {
            name: displayNameOf(initial),
            k8sName: initial.id,
            description: descriptionOf(initial),
          },
          // A draft's name stays editable: a taken one is a reason the backend refuses a create.
          ...(subscription ? {} : { maxLength: MAX_ID_LENGTH, editableK8sName: true }),
        }
      : { maxLength: MAX_ID_LENGTH },
  );

  const [selectedGroups, setSelectedGroups] = useState<SelectionOptions[]>(() =>
    (initial ? groupsOf(initial) : []).map((name) => ({ id: name, name, selected: true })),
  );
  const [groupsTouched, setGroupsTouched] = useState(false);
  const [modelsTouched, setModelsTouched] = useState(false);
  const savedOrganizationId = subscription ? organizationIdOf(subscription) : '';
  const [organizationId, setOrganizationId] = useState(initial ? organizationIdOf(initial) : '');
  // A subscription saved without an organization opens with Save disabled, so it says why straight
  // away instead of waiting for the field to be touched.
  const [organizationTouched, setOrganizationTouched] = useState(!!subscription && !organizationId);
  const [priority, setPriority] = useState<number | undefined>(initial?.spec?.priority ?? 0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(draft?.error ?? null);

  const [initialModels] = useState<SubscriptionModelEntry[]>(() =>
    initial ? buildInitialModels(initial, availableModels, !!subscription) : [],
  );

  const {
    models,
    isAddModelsModalOpen,
    setIsAddModelsModalOpen,
    editLimitsTarget,
    setEditLimitsTarget,
    editingModel,
    allModelsHaveRateLimits,
    handleAddModels,
    handleRemoveModel,
    handleRemoveModels,
    handleSaveRateLimits,
    handleCloseRateLimitsModal,
  } = useSubscriptionModels(initialModels);

  // A poll that leaves the inspected model without its partial status closes its dialog. Opened from
  // the selected models, the dialog would return focus to that row's status, which is no longer a
  // button, so focus goes to Add models instead. The picker restores its own focus (AddModelsModal).
  const addModelsRef = useRef<HTMLButtonElement>(null);
  // Counts the closes that move focus; the effect runs after the dialog's unmount has tried its trigger.
  const [addModelsFocus, setAddModelsFocus] = useState(0);
  if (statusModelId && !hasPartialModelStatus(statusModel)) {
    setStatusModelId(undefined);
    if (!isAddModelsModalOpen) setAddModelsFocus((n) => n + 1);
  }
  useEffect(() => {
    if (addModelsFocus) addModelsRef.current?.focus();
  }, [addModelsFocus]);

  const isNameValid = isK8sNameDescriptionDataValid(nameDescData);
  const selectedGroupNames = selectedGroups.filter((g) => g.selected).map((g) => String(g.id));

  const initialGroupNames = useMemo(() => new Set(subscription ? groupsOf(subscription) : []), [subscription]);
  const initialModelKeys = useMemo(() => new Set(initialModels.map(entryKey)), [initialModels]);
  const groupsChanged =
    isEditing &&
    (selectedGroupNames.length !== initialGroupNames.size || selectedGroupNames.some((g) => !initialGroupNames.has(g)));
  const modelsChanged =
    isEditing && (models.length !== initialModelKeys.size || models.some((m) => !initialModelKeys.has(entryKey(m))));
  const showPolicyWarning = isEditing && (groupsChanged || modelsChanged);

  const fieldErrors = fieldErrorsOf(subscriptionFormSchema, {
    priority: priority == null || Number.isNaN(priority) ? Number.NaN : priority,
    groups: selectedGroupNames,
    models,
  });
  const isPriorityValid = priority != null && !Number.isNaN(priority);
  // Required on create and edit, and immutable once set (validateOrganizationImmutable in the
  // backend's internal/servers/subscriptions_server.go), so the edit form shows a set one read-only.
  const organizationLocked = !!savedOrganizationId;
  const organizationMissing = !organizationId;

  // What the user can change, so Cancel asks before discarding it and an unchanged edit can't be saved
  // (as the organization and model forms do).
  const formValues = JSON.stringify({
    name: nameDescData.name,
    k8sName: nameDescData.k8sName.value,
    description: nameDescData.description,
    groups: selectedGroupNames,
    organizationId,
    priority: priority == null || Number.isNaN(priority) ? null : priority,
    models: models.map((m) => [entryKey(m), m.tokenRateLimits, m.unlimited]),
  });
  const [initialValues] = useState(formValues);
  const isDirty = formValues !== initialValues;
  const leave = () => navigate(returnTo ?? getSectionUrl('subscriptions'));
  const [requestLeave, discardModal] = useConfirmDiscard(isDirty && !isSubmitting, leave);

  const canSubmit =
    (!isEditing || isDirty) &&
    isNameValid &&
    Object.keys(fieldErrors).length === 0 &&
    allModelsHaveRateLimits &&
    isPriorityValid &&
    !organizationMissing &&
    !isSubmitting;

  // The organization select lists the organizations by name; an edited subscription keeps its
  // organization even when the backend no longer lists it.
  const organizationOptions = useMemo(() => {
    const options = organizations
      .map((o) => ({ value: o.id, label: tenantNameOf(o) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (savedOrganizationId && !options.some((o) => o.value === savedOrganizationId)) {
      options.push({ value: savedOrganizationId, label: savedOrganizationId });
    }
    return options;
  }, [organizations, savedOrganizationId]);

  /**
   * The annotations to write: on an edit the whole map as loaded (an Update replaces the map), with
   * the display name and description set, or dropped when cleared. An unchanged name keeps the
   * annotation as it was.
   */
  const annotationsPayload = (): Record<string, string> => {
    const annotations = { ...(subscription?.metadata?.annotations ?? {}) };
    const set = (key: string, value: string) => {
      if (value) annotations[key] = value;
      else delete annotations[key];
    };
    const name = nameDescData.name.trim();
    if (!subscription || name !== displayNameOf(subscription)) {
      set(DISPLAY_NAME, name);
    }
    set(DESCRIPTION, nameDescData.description.trim());
    return annotations;
  };

  const handleSubmit = async () => {
    if (priority == null || Number.isNaN(priority)) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    // The whole spec: what the form edits, and as loaded what it doesn't (users, token metadata,
    // inference priority, guardrails), since the mask names spec as a whole.
    const loaded = subscription?.spec;
    const spec: MessageInitShape<typeof SubscriptionSpecSchema> = {
      owner: { groups: selectedGroupNames, users: loaded?.owner?.users ?? [] },
      modelRefs: models.map(refPayload),
      priority,
      organization: { id: organizationId },
      tokenMetadata: loaded?.tokenMetadata,
      inferencePriority: loaded?.inferencePriority,
      guardrails: loaded?.guardrails ?? [],
    };
    // The name the notification center uses if the write outlasts the form.
    const shownName = nameDescData.name.trim() || nameDescData.k8sName.value;
    try {
      if (subscription) {
        await updateSubscription(
          {
            object: {
              id: subscription.id,
              metadata: { annotations: annotationsPayload(), version: subscription.metadata?.version ?? 0 },
              spec,
            },
            updateMask: { paths: ['spec', 'metadata.annotations'] },
            // The backend answers Aborted when the subscription changed since it was read.
            lock: true,
          },
          shownName,
        );
      } else {
        const id = nameDescData.k8sName.value;
        // The backend creates the managed authorization policy, <id>-policy, with it.
        const object = { id, metadata: { name: id, annotations: annotationsPayload() }, spec };
        // The subscription as sent, kept should the backend refuse it after the form has left, and
        // the organization's name as the select shows it, for the notification that it is active
        // (none when the organizations didn't load).
        const organization = organizations.find((o) => o.id === organizationId);
        await createSubscription(
          { object },
          shownName,
          toJson(SubscriptionSchema, create(SubscriptionSchema, object)),
          organization && tenantNameOf(organization),
        );
      }
      // A created subscription replaces its create form in history, so Back doesn't land on it, empty.
      // The notification center says how the write went (useBackgroundWrites).
      navigate(returnTo ?? getSectionUrl('subscriptions'), { replace: !isEditing });
    } catch (e) {
      const error = describeError(e);
      setSubmitError(
        error.kind === 'notAvailable'
          ? `${isEditing ? 'Saving' : 'Creating'} subscriptions is not available on this AI grid backend.`
          : error.message,
      );
      setIsSubmitting(false);
    }
  };

  const showNoModelsWarning = !isEditing && availableModels.length === 0 && models.length === 0;
  const canAddModels = isEditing || availableModels.length > 0;

  const rows: SubscriptionModelRow[] = models.map((entry) => {
    const currentModel = availableModels.find((model) => model.id === entryModelId(entry));
    const opensStatus = !isEditing && hasPartialModelStatus(currentModel);
    // A model the subscription has saved shows its registration in it. One added here shows the
    // Models list's label, from the latest poll of the models (the copy taken when it was added
    // only while the poll doesn't list it), so a row never keeps a status the model has left.
    const latest = currentModel ?? entry.model;
    const status =
      entry.saved && subscriptionInfo
        ? registrationStatusOf(subscriptionInfo.modelRegistrations, entry.ref)
        : { status: latest?.state ?? 'Unknown', model: latest };
    return {
      key: entryKey(entry),
      title: refTitleOf(entry.ref, entry.model),
      name: entry.ref.name,
      ...status,
      ...(opensStatus ? { onOpenStatus: () => setStatusModelId(currentModel.id) } : {}),
      tokenRateLimits: entry.tokenRateLimits,
      unlimited: entry.unlimited,
    };
  });

  // The token limits are the one requirement the form states only in the models table, so the
  // submit button names the models that still lack one, as a disabled delete or row action says why
  // (DeleteModal, SimpleMenuActions).
  const modelsWithoutLimits = rows.filter((r) => !r.unlimited && r.tokenRateLimits.length === 0).map((r) => r.title);
  const submitBlockedReason =
    !isSubmitting && modelsWithoutLimits.length > 0
      ? `Add a token limit to ${listOf(modelsWithoutLimits)}.`
      : undefined;
  const submitRef = useRef<HTMLButtonElement>(null);

  let organizationHelper = (
    <FormHelperText>
      <HelperText>
        <HelperTextItem>
          {organizationLocked
            ? 'The organization can’t be changed once it is set.'
            : 'The organization whose users this subscription serves.'}
        </HelperTextItem>
      </HelperText>
    </FormHelperText>
  );
  // A set organization that no longer exists can't be changed here (the backend refuses a changed
  // one), so the form says so and what to do instead, once the organizations are known
  // (isOrganizationMissing says when).
  const savedOrganizationGone =
    organizationLocked && isOrganizationMissing(organizationId, organizations, organizationsKnown);
  if (organizationsError) {
    organizationHelper = errorText(`Unable to load organizations: ${organizationsError.message}`);
  } else if (savedOrganizationGone) {
    organizationHelper = (
      <FormHelperText>
        <HelperText>
          <HelperTextItem variant="warning" data-testid="subscription-organization-missing">
            {`${MISSING_ORGANIZATION}. ${missingOrganizationReason(organizationId)}`}
          </HelperTextItem>
        </HelperText>
      </FormHelperText>
    );
  } else if (organizationTouched && organizationMissing) {
    organizationHelper = errorText(ORGANIZATION_REQUIRED);
  }

  return (
    <>
      <Form maxWidth="750px">
        <K8sNameDescriptionField
          data={nameDescData}
          onDataChange={onNameDescChange}
          dataTestId="subscription-name-desc"
          {...(isEditing ? {} : { nameHelperText: NAME_SUFFIX_HELP })}
        />

        <FormGroup label="Organization" fieldId="subscription-organization" isRequired={!organizationLocked}>
          {organizationLocked ? (
            <TextInput
              id="subscription-organization"
              data-testid="subscription-organization"
              readOnlyVariant="default"
              value={organizationOptions.find((o) => o.value === organizationId)?.label ?? organizationId}
            />
          ) : (
            <TypeaheadSelect
              id="subscription-organization"
              data-testid="subscription-organization"
              aria-label="Organization"
              value={organizationId}
              options={organizationOptions}
              placeholder={SELECT_ORGANIZATION}
              status={organizationTouched && organizationMissing ? 'danger' : undefined}
              onChange={(value) => {
                setOrganizationTouched(true);
                setOrganizationId(value);
              }}
              onBlur={() => setOrganizationTouched(true)}
            />
          )}
          {organizationHelper}
        </FormGroup>

        <FormGroup label="Priority" fieldId="subscription-priority" isRequired>
          <NumberInput
            id="subscription-priority"
            data-testid="subscription-priority"
            inputAriaLabel="Priority"
            minusBtnAriaLabel="Decrease priority"
            plusBtnAriaLabel="Increase priority"
            value={priority == null || Number.isNaN(priority) ? '' : priority}
            min={MIN_PRIORITY}
            max={MAX_PRIORITY}
            onMinus={() =>
              setPriority(Math.max(MIN_PRIORITY, (priority == null || Number.isNaN(priority) ? 0 : priority) - 1))
            }
            onPlus={() =>
              setPriority(Math.min(MAX_PRIORITY, (priority == null || Number.isNaN(priority) ? 0 : priority) + 1))
            }
            onChange={(event: React.FormEvent<HTMLInputElement>) => {
              const inputValue = event.currentTarget.value;
              if (inputValue === '') {
                setPriority(NaN);
              } else {
                const parsed = parseInt(inputValue, 10);
                if (!Number.isNaN(parsed)) {
                  setPriority(Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, parsed)));
                }
              }
            }}
          />
          <FormHelperText>
            <HelperText>
              <HelperTextItem variant={isPriorityValid ? 'default' : 'error'}>
                {isPriorityValid ? 'Higher numbers indicate higher priority.' : fieldErrors.priority}
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>

        <FormGroup label="Groups" fieldId="subscription-groups" isRequired>
          <MultiSelection
            ariaLabel="Groups"
            toggleAriaLabel="Groups options"
            value={selectedGroups}
            setValue={(newValue) => {
              setGroupsTouched(true);
              setSelectedGroups(newValue);
            }}
            toggleTestId="subscription-groups"
            isCreatable
            createOptionMessage={(value) => `Add group "${value}"`}
            placeholder="Enter a group name"
          />
          {groupsTouched && fieldErrors.groups ? (
            errorText(fieldErrors.groups)
          ) : (
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  Enter the names of user groups to grant them access to models in the subscription.
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
          {selectedGroupNames.includes(SYSTEM_AUTHENTICATED_GROUP) && <SystemAuthenticatedWarning />}
        </FormGroup>

        {showNoModelsWarning ? (
          <Alert variant="warning" isInline title="No models available" data-testid="no-models-warning">
            To create a subscription, first deploy a model from the Models page.
          </Alert>
        ) : (
          <MaasModelsSection
            rows={rows}
            editable
            onAddModels={canAddModels ? () => setIsAddModelsModalOpen(true) : undefined}
            addModelsRef={addModelsRef}
            onEditLimits={(index) => setEditLimitsTarget(index)}
            onRemoveModel={(index) => {
              setModelsTouched(true);
              handleRemoveModel(index);
            }}
            validationError={modelsTouched ? fieldErrors.models : undefined}
          />
        )}

        {isAddModelsModalOpen && canAddModels && (
          <AddModelsModal
            currentModels={models}
            status={
              hasPartialModelStatus(statusModel)
                ? { model: statusModel, clusters, onClose: () => setStatusModelId(undefined) }
                : undefined
            }
            focusModelId={pickerFocusModelId}
            onOpenStatus={
              isEditing
                ? undefined
                : (model) => {
                    setPickerFocusModelId(model.id);
                    setStatusModelId(model.id);
                  }
            }
            onAdd={(added) => {
              setModelsTouched(true);
              handleAddModels(added);
            }}
            onRemove={(removed) => {
              setModelsTouched(true);
              handleRemoveModels(removed);
            }}
            onClose={() => setIsAddModelsModalOpen(false)}
          />
        )}

        {!isAddModelsModalOpen && hasPartialModelStatus(statusModel) && (
          <ModelStatusModal model={statusModel} clusters={clusters} onClose={() => setStatusModelId(undefined)} />
        )}

        {editLimitsTarget != null && editingModel && (
          <EditRateLimitsModal
            modelName={refTitleOf(editingModel.ref, editingModel.model)}
            rateLimits={editingModel.tokenRateLimits}
            onSave={handleSaveRateLimits}
            onClose={handleCloseRateLimitsModal}
          />
        )}

        {showPolicyWarning && (
          <Alert
            variant="warning"
            isInline
            title="Other authorization policies are not updated"
            data-testid="policy-change-warning"
          >
            The authorization policy created with this subscription is updated with these changes. After saving, update
            any other authorization policy for these models separately.
          </Alert>
        )}

        {submitError && (
          <Alert variant="danger" isInline title={`Unable to ${isEditing ? 'update' : 'create'} subscription`}>
            {submitError}
          </Alert>
        )}

        <ActionGroup>
          <Button
            ref={submitRef}
            variant="primary"
            onClick={handleSubmit}
            // Aria-disabled while a reason shows, so the button takes focus and shows why from the keyboard.
            isAriaDisabled={!!submitBlockedReason}
            isDisabled={!submitBlockedReason && !canSubmit}
            isLoading={isSubmitting}
            data-testid={isEditing ? 'update-subscription-button' : 'create-subscription-button'}
          >
            {isEditing ? 'Save changes' : 'Create subscription'}
          </Button>
          {submitBlockedReason && (
            // By triggerRef, not wrapped around the button: a wrapped trigger gets a wrapper element,
            // which takes the button out of the action group's layout.
            <Tooltip content={submitBlockedReason} triggerRef={submitRef} />
          )}
          <Button
            variant="link"
            onClick={requestLeave}
            isDisabled={isSubmitting}
            data-testid="cancel-subscription-button"
          >
            Cancel
          </Button>
        </ActionGroup>
      </Form>
      {discardModal}
    </>
  );
};
