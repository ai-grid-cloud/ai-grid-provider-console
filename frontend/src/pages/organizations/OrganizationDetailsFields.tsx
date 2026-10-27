import { useEffect, useRef, useState } from 'react';
import {
  Button,
  FormGroup,
  FormHelperText,
  FormSection,
  HelperText,
  HelperTextItem,
  InputGroup,
  InputGroupItem,
  TextInput,
} from '@patternfly/react-core';
import { MinusCircleIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { ReadOnlyField } from '../../components/ReadOnlyField';

type Value = { name: string; domains: string[] };

type Props = {
  value: Value;
  onChange: (value: Value) => void;
  /** Client-side errors by path ("name", "domains.0"); shown once the field was left. */
  errors: Record<string, string>;
  /** The server's errors by the same paths; shown whether or not the field was touched. */
  serverErrors?: Record<string, string>;
  /** The name is fixed once the organization exists. */
  isNameEditable: boolean;
  isDisabled?: boolean;
};

/** A field's error, or its help when it has none (PatternFly: the error replaces the help). */
const Help: React.FC<{ error?: string; children?: React.ReactNode }> = ({ error, children }) =>
  error || children ? (
    <FormHelperText>
      <HelperText>
        <HelperTextItem variant={error ? 'error' : 'default'}>{error ?? children}</HelperTextItem>
      </HelperText>
    </FormHelperText>
  ) : null;

const ADD_DOMAIN_ID = 'tenant-add-domain';

/** An organization's name and domains, with each error under its own field. */
export const OrganizationDetailsFields: React.FC<Props> = ({
  value,
  onChange,
  errors,
  serverErrors = {},
  isNameEditable,
  isDisabled,
}) => {
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const touch = (path: string) => setTouched((previous) => new Set([...previous, path]));
  const error = (path: string) => serverErrors[path] ?? (touched.has(path) ? errors[path] : undefined);
  const setDomain = (index: number, text: string) =>
    onChange({ ...value, domains: value.domains.map((old, i) => (i === index ? text : old)) });
  // The domain field (or "add", the Add domain button) to focus once the domains have rendered.
  // "Add domain" moves focus to the field it adds.
  const focusDomain = useRef<number | 'add' | undefined>(undefined);
  // "Remove domain" takes its button away, so focus moves to the previous domain (the next one for
  // the first), or to "Add domain" when none is left, rather than to the page's body.
  const removeDomain = (index: number) => {
    focusDomain.current = value.domains.length > 1 ? Math.max(index - 1, 0) : 'add';
    onChange({ ...value, domains: value.domains.filter((_, i) => i !== index) });
  };
  useEffect(() => {
    if (focusDomain.current === 'add') {
      document.getElementById(ADD_DOMAIN_ID)?.focus();
      focusDomain.current = undefined;
    } else if (focusDomain.current !== undefined && focusDomain.current < value.domains.length) {
      document.getElementById(`tenant-domain-${focusDomain.current}`)?.focus();
      focusDomain.current = undefined;
    }
  });
  // A rule over all domains (they must be unique) shows once any domain was left.
  const listError =
    serverErrors.domains ?? ([...touched].some((path) => path.startsWith('domains.')) ? errors.domains : undefined);

  return (
    <>
      {isNameEditable ? (
        <FormGroup label="Name" fieldId="tenant-name" isRequired>
          <TextInput
            id="tenant-name"
            value={value.name}
            isDisabled={isDisabled}
            isRequired
            onBlur={() => touch('name')}
            validated={error('name') ? 'error' : 'default'}
            onChange={(_event, name) => onChange({ ...value, name })}
          />
          <Help error={error('name')}>Use lowercase letters, numbers, and hyphens.</Help>
        </FormGroup>
      ) : (
        <ReadOnlyField
          label="Name"
          fieldId="tenant-name"
          value={value.name}
          reason="The name can't be changed once the organization exists."
        />
      )}
      <FormSection title="Domains" titleElement="h2">
        {value.domains.map((domain, index) => (
          <FormGroup key={index} label={`Domain ${index + 1}`} fieldId={`tenant-domain-${index}`} isRequired>
            <InputGroup>
              <InputGroupItem isFill>
                <TextInput
                  id={`tenant-domain-${index}`}
                  value={domain}
                  isDisabled={isDisabled}
                  isRequired
                  onBlur={() => touch(`domains.${index}`)}
                  validated={error(`domains.${index}`) ? 'error' : 'default'}
                  onChange={(_event, text) => setDomain(index, text)}
                />
              </InputGroupItem>
              <InputGroupItem isPlain>
                <Button
                  variant="plain"
                  icon={<MinusCircleIcon />}
                  aria-label={`Remove domain ${index + 1}`}
                  isDisabled={isDisabled}
                  onClick={() => removeDomain(index)}
                />
              </InputGroupItem>
            </InputGroup>
            <Help error={error(`domains.${index}`)} />
          </FormGroup>
        ))}
        <Help error={listError} />
        <div>
          <Button
            id={ADD_DOMAIN_ID}
            variant="link"
            isInline
            icon={<PlusCircleIcon />}
            isDisabled={isDisabled}
            onClick={() => {
              focusDomain.current = value.domains.length;
              onChange({ ...value, domains: [...value.domains, ''] });
            }}
          >
            Add domain
          </Button>
        </div>
      </FormSection>
    </>
  );
};
