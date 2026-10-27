import { Fragment } from 'react';
import { ToggleGroup, ToggleGroupItem, Tooltip } from '@patternfly/react-core';
import { DesktopIcon, MoonIcon, SunIcon } from '@patternfly/react-icons';
import { useTheme } from '../context/useTheme';
import type { ThemeChoice } from '../utilities/theme';

const choices: { choice: ThemeChoice; label: string; tooltip: string; icon: React.ReactNode }[] = [
  { choice: 'light', label: 'Light theme', tooltip: 'Light', icon: <SunIcon /> },
  { choice: 'dark', label: 'Dark theme', tooltip: 'Dark', icon: <MoonIcon /> },
  { choice: 'system', label: 'System theme', tooltip: "System: the operating system's setting", icon: <DesktopIcon /> },
];

/**
 * The masthead's theme switch, as odh-dashboard's masthead has (HeaderTools.tsx), with a third
 * choice, System, that drops a saved theme and follows the operating system again.
 */
export const ThemeToggle: React.FC = () => {
  const { choice, setChoice } = useTheme();
  return (
    <ToggleGroup aria-label="Theme">
      {choices.map((c) => (
        <Fragment key={c.choice}>
          <ToggleGroupItem
            buttonId={`theme-${c.choice}`}
            icon={c.icon}
            aria-label={c.label}
            isSelected={choice === c.choice}
            onChange={() => setChoice(c.choice)}
          />
          {/* On the button itself, not the item's wrapper, so keyboard focus shows it too. */}
          <Tooltip content={c.tooltip} triggerRef={() => document.getElementById(`theme-${c.choice}`)!} />
        </Fragment>
      ))}
    </ToggleGroup>
  );
};
