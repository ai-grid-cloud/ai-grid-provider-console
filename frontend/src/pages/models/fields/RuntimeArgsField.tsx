// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/fields/RuntimeArgsField.tsx at 62319b8.
// Extracted from packages/model-serving/src/components/deploymentWizard/fields/RuntimeArgsField.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
import React from 'react';
import {
  Button,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Icon,
  List,
  ListItem,
  Popover,
  Stack,
  TextArea,
} from '@patternfly/react-core';
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons';
import type { RuntimeArgsFieldData } from './runtimeArgs';

// Component
type RuntimeArgsFieldProps = {
  data?: RuntimeArgsFieldData;
  onChange?: (data: RuntimeArgsFieldData) => void;
  predefinedArgs?: string[];
};

export const RuntimeArgsField: React.FC<RuntimeArgsFieldProps> = ({
  data = { enabled: false, args: [] },
  onChange,
  predefinedArgs,
}) => {
  const [hasTyped, setHasTyped] = React.useState(false);
  const joined = data.args.join('\n');
  const displayValue = data.args.length > 0 && !hasTyped ? `${joined}\n` : joined;
  const handleTextAreaChange = (_e: React.FormEvent<HTMLTextAreaElement>, textValue: string) => {
    setHasTyped(true);
    const args = textValue.split('\n');
    const newData = { args, enabled: args.some((a) => a.trim().length > 0) };
    onChange?.(newData);
  };

  return (
    <Stack hasGutter>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span id="runtime-args-label" className="pf-v6-u-font-weight-bold" data-testid="runtime-args-label">
            Additional runtime arguments
          </span>
          <Popover
            bodyContent={
              <div>
                Serving runtime arguments define how the deployed model behaves. Overwriting predefined arguments only
                affects this model deployment.
              </div>
            }
          >
            <Icon aria-label="Additional serving runtime arguments info" role="button">
              <OutlinedQuestionCircleIcon />
            </Icon>
          </Popover>
        </div>
        <Popover
          headerContent="Predefined arguments of the selected serving runtime"
          bodyContent={
            <List isPlain data-testid="predefined-args-list">
              {!predefinedArgs || predefinedArgs.length === 0 ? (
                <ListItem key="0">No predefined arguments</ListItem>
              ) : (
                predefinedArgs.map((arg: string, index: number) => <ListItem key={index}>{arg}</ListItem>)
              )}
            </List>
          }
          footerContent={
            <div>
              To <strong>overwrite</strong> a predefined argument, specify a new value in the{' '}
              <strong>Additional serving runtime arguments</strong> field.
            </div>
          }
        >
          <Button isInline data-testid="view-predefined-args-button" variant="link" isAriaDisabled={!predefinedArgs}>
            View predefined arguments
          </Button>
        </Popover>
      </div>

      <Stack>
        <TextArea
          id="runtime-args-textarea"
          data-testid="runtime-args-textarea"
          aria-labelledby="runtime-args-label"
          placeholder={`--arg\n--arg2=value2\n--arg3 value3`}
          value={displayValue}
          onChange={handleTextAreaChange}
          autoResize
        />
        <FormHelperText>
          <HelperText>
            <HelperTextItem>
              {`Overwriting the runtime's predefined listening port or
               model location will likely result in a failed deployment.`}
            </HelperTextItem>
          </HelperText>
        </FormHelperText>
      </Stack>
    </Stack>
  );
};
