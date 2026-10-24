import { ToggleGroup, ToggleGroupItem } from '@patternfly/react-core';
import { MoonIcon, SunIcon } from '@patternfly/react-icons';
import { useTheme } from '../context/useTheme';

/** The masthead's light and dark switch, as odh-dashboard's masthead has (HeaderTools.tsx). */
export const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup aria-label="Theme">
      <ToggleGroupItem
        icon={<SunIcon />}
        aria-label="Light theme"
        isSelected={theme === 'light'}
        onChange={() => setTheme('light')}
      />
      <ToggleGroupItem
        icon={<MoonIcon />}
        aria-label="Dark theme"
        isSelected={theme === 'dark'}
        onChange={() => setTheme('dark')}
      />
    </ToggleGroup>
  );
};
