// Ported from krisv/ai-grid-cloud-provider-poc src/app/pages/models/fields/RuntimeArgsField.tsx at 62319b8.
// Extracted from packages/model-serving/src/components/deploymentWizard/fields/RuntimeArgsField.tsx
// upstream commit: 8051fbbea117457b4da4074fb2856b732e6677a4
// The schema, helpers and hook, in their own module so the component file exports only the component.
import React from 'react';
import { z } from '../../../validation/zod';

/** A container environment variable, as ModelContainer.env lists them. */
export type EnvVar = { name: string; value: string };

/** The variable the console passes vLLM's extra arguments in (the PoC's deploymentResources). */
export const RUNTIME_ARGS_ENV = 'VLLM_ADDITIONAL_ARGS';

/**
 * The runtime arguments a model's env carries, one per flag as the wizard shows them. The wizard
 * joins its lines with spaces, so the value is cut before each flag (`-x`, `--x`) that starts
 * after whitespace outside quotes; each piece keeps its own text, so a flag's value
 * (`--max-model-len 4096`) and a quoted value (`--name "a  --b"`) survive an edit unchanged.
 */
export const runtimeArgsOf = (env: readonly EnvVar[] | undefined): string[] => {
  const value = env?.find((v) => v.name === RUNTIME_ARGS_ENV)?.value ?? '';
  const args: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c) && /^\s+--?[A-Za-z]/.test(value.slice(i))) {
      args.push(value.slice(start, i));
      start = i + value.slice(i).search(/\S/);
      i = start - 1;
    }
  }
  args.push(value.slice(start));
  return args.map((arg) => arg.trim()).filter(Boolean);
};

/** The env with its runtime arguments replaced, keeping every other variable in place. */
export const withRuntimeArgs = (env: readonly EnvVar[] | undefined, args: string[]): EnvVar[] => {
  const others = (env ?? []).filter((v) => v.name !== RUNTIME_ARGS_ENV);
  return args.length > 0 ? [...others, { name: RUNTIME_ARGS_ENV, value: args.join(' ') }] : others;
};

// Schema
export const runtimeArgsFieldSchema = z.object({
  enabled: z.boolean(),
  args: z.array(z.string()),
});

export type RuntimeArgsFieldData = z.infer<typeof runtimeArgsFieldSchema>;

export const isValidRuntimeArgs = (value: unknown): value is RuntimeArgsFieldData => {
  return runtimeArgsFieldSchema.safeParse(value).success;
};

/**
 * Drops blank lines and `#` comment headers before writing args onto a container, and trims the
 * rest: comment lines are useful in the wizard textarea but are not valid container argv, and
 * stray spaces would make an unchanged argument look edited.
 */
export const filterRuntimeArgsForContainer = (args: string[]): string[] =>
  args.map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('#'));

// Hook
export type RuntimeArgsFieldHook = {
  data: RuntimeArgsFieldData | undefined;
  setData: React.Dispatch<React.SetStateAction<RuntimeArgsFieldData | undefined>>;
};

export const useRuntimeArgsField = (existingData?: RuntimeArgsFieldData): RuntimeArgsFieldHook => {
  const [runtimeArgsData, setRuntimeArgsData] = React.useState<RuntimeArgsFieldData | undefined>(
    existingData || { enabled: false, args: [] },
  );

  return {
    data: runtimeArgsData,
    setData: setRuntimeArgsData,
  };
};
