// Ported from opendatahub-io/odh-dashboard packages/observability/src/perses/theme.ts at 261acf1
// (Apache-2.0), the PatternFly look odh-dashboard's Observability page and the OpenShift console's
// monitoring plugin give Perses: its MUI components and ECharts styled with PatternFly tokens.
// Changed here: the chart palette taken from the PatternFly chart tokens directly instead of
// through @patternfly/react-charts.
import type { Theme, ThemeOptions } from '@mui/material';
import { generateChartsTheme, getTheme, typography } from '@perses-dev/components';
import type { PersesChartsTheme } from '@perses-dev/components';
import {
  chart_theme_multi_color_unordered_ColorScale_100,
  chart_theme_multi_color_unordered_ColorScale_200,
  chart_theme_multi_color_unordered_ColorScale_300,
  chart_theme_multi_color_unordered_ColorScale_400,
  chart_theme_multi_color_unordered_ColorScale_500,
  chart_theme_multi_color_unordered_ColorScale_600,
  chart_theme_multi_color_unordered_ColorScale_700,
  chart_theme_multi_color_unordered_ColorScale_800,
  chart_theme_multi_color_unordered_ColorScale_900,
  chart_theme_multi_color_unordered_ColorScale_1000,
  chart_theme_multi_color_unordered_ColorScale_1100,
  chart_theme_multi_color_unordered_ColorScale_1200,
  chart_theme_multi_color_unordered_ColorScale_1300,
  chart_theme_multi_color_unordered_ColorScale_1400,
  chart_theme_multi_color_unordered_ColorScale_1500,
  chart_theme_multi_color_unordered_ColorScale_1600,
  chart_theme_multi_color_unordered_ColorScale_1700,
  chart_theme_multi_color_unordered_ColorScale_1800,
  chart_theme_multi_color_unordered_ColorScale_1900,
  chart_theme_multi_color_unordered_ColorScale_2000,
  chart_theme_multi_color_unordered_ColorScale_2100,
  chart_theme_multi_color_unordered_ColorScale_2200,
  chart_theme_multi_color_unordered_ColorScale_2300,
  chart_theme_multi_color_unordered_ColorScale_2400,
  chart_theme_multi_color_unordered_ColorScale_2500,
  chart_theme_multi_color_unordered_ColorScale_2600,
  chart_theme_multi_color_unordered_ColorScale_2700,
  chart_theme_multi_color_unordered_ColorScale_2800,
  chart_theme_multi_color_unordered_ColorScale_2900,
  chart_theme_multi_color_unordered_ColorScale_3000,
  chart_theme_multi_color_unordered_ColorScale_3100,
  chart_theme_multi_color_unordered_ColorScale_3200,
  chart_theme_multi_color_unordered_ColorScale_3300,
  chart_theme_multi_color_unordered_ColorScale_3400,
  chart_theme_multi_color_unordered_ColorScale_3500,
  t_color_blue_20,
  t_color_blue_30,
  t_color_gray_95,
  t_color_white,
  t_global_color_brand_default,
  t_global_color_brand_hover,
  t_global_font_family_body,
  t_global_spacer_md,
} from '@patternfly/react-tokens';

// Extend MUI theme to include x-date-pickers components
declare module '@mui/material/styles' {
  interface Components {
    MuiPickersDay?: object;
    MuiClock?: object;
    MuiClockPointer?: object;
    MuiClockNumber?: object;
    MuiStaticDateTimePicker?: {
      defaultProps?: {
        minDate?: Date;
        maxDate?: Date;
      };
    };
    MuiDateTimeField?: {
      defaultProps?: {
        minDate?: Date;
        maxDate?: Date;
      };
    };
  }
}

/**
 * MUI X defaults Custom Time Range years to 1900–2099. Bound the picker via theme
 * defaultProps (Perses DateTimeRangePicker does not expose minDate/maxDate).
 * Keep a little future headroom for timezone / "now" edge cases.
 *
 * Custom range becomes 2020 to current year + 1.
 */
const getCustomTimeRangeDateBounds = (currentYear: number): { minDate: Date; maxDate: Date } => ({
  minDate: new Date(2020, 0, 1),
  maxDate: new Date(currentYear + 1, 11, 31),
});

// Override eChart defaults with PatternFly colors.
const patternflyBlue400 = '#0066cc';
const patternflyBlue500 = '#004080';
const patternflyBlue600 = '#002952';
const defaultPaletteColors = [patternflyBlue400, patternflyBlue500, patternflyBlue600];

// PatternFly's multi-color unordered chart palette (@patternfly/react-charts ChartThemeColor
// multiUnordered: chart_theme_multi_color_unordered_ColorScale_100 to _3500, in that order), as hex:
// ECharts draws on a <canvas>, whose fillStyle doesn't resolve CSS variables.
const patternflyChartsMultiUnorderedPalette = [
  chart_theme_multi_color_unordered_ColorScale_100,
  chart_theme_multi_color_unordered_ColorScale_200,
  chart_theme_multi_color_unordered_ColorScale_300,
  chart_theme_multi_color_unordered_ColorScale_400,
  chart_theme_multi_color_unordered_ColorScale_500,
  chart_theme_multi_color_unordered_ColorScale_600,
  chart_theme_multi_color_unordered_ColorScale_700,
  chart_theme_multi_color_unordered_ColorScale_800,
  chart_theme_multi_color_unordered_ColorScale_900,
  chart_theme_multi_color_unordered_ColorScale_1000,
  chart_theme_multi_color_unordered_ColorScale_1100,
  chart_theme_multi_color_unordered_ColorScale_1200,
  chart_theme_multi_color_unordered_ColorScale_1300,
  chart_theme_multi_color_unordered_ColorScale_1400,
  chart_theme_multi_color_unordered_ColorScale_1500,
  chart_theme_multi_color_unordered_ColorScale_1600,
  chart_theme_multi_color_unordered_ColorScale_1700,
  chart_theme_multi_color_unordered_ColorScale_1800,
  chart_theme_multi_color_unordered_ColorScale_1900,
  chart_theme_multi_color_unordered_ColorScale_2000,
  chart_theme_multi_color_unordered_ColorScale_2100,
  chart_theme_multi_color_unordered_ColorScale_2200,
  chart_theme_multi_color_unordered_ColorScale_2300,
  chart_theme_multi_color_unordered_ColorScale_2400,
  chart_theme_multi_color_unordered_ColorScale_2500,
  chart_theme_multi_color_unordered_ColorScale_2600,
  chart_theme_multi_color_unordered_ColorScale_2700,
  chart_theme_multi_color_unordered_ColorScale_2800,
  chart_theme_multi_color_unordered_ColorScale_2900,
  chart_theme_multi_color_unordered_ColorScale_3000,
  chart_theme_multi_color_unordered_ColorScale_3100,
  chart_theme_multi_color_unordered_ColorScale_3200,
  chart_theme_multi_color_unordered_ColorScale_3300,
  chart_theme_multi_color_unordered_ColorScale_3400,
  chart_theme_multi_color_unordered_ColorScale_3500,
].map((token) => token.value);

type PatternFlyTheme = 'light' | 'dark';

const mapPatterflyThemeToMUI = (theme: PatternFlyTheme, currentYear: number): ThemeOptions => {
  const isDark = theme === 'dark';
  const primaryTextColor = isDark ? t_color_white.value : t_color_gray_95.value;
  const primaryBackgroundColor = 'var(--pf-t--global--background--color--primary--default)';
  // MUI needs literal colours here (it computes shades from them). @patternfly/react-tokens has only
  // the light values; the dark theme's brand colours are blue 30 and 20 (tokens-dark.scss,
  // --pf-t--global--dark--color--brand--100 and --200).
  const brandColor = isDark ? t_color_blue_30.value : t_global_color_brand_default.value;
  const brandHoverColor = isDark ? t_color_blue_20.value : t_global_color_brand_hover.value;
  const { minDate, maxDate } = getCustomTimeRangeDateBounds(currentYear);

  return {
    typography: {
      ...typography,
      fontFamily: 'var(--pf-t--global--font--family--body)',
      subtitle1: {
        // Card Heading
        fontFamily: 'var(--pf-t--global--font--family--heading)',
        fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
        lineHeight: 'var(--pf-v6-c-card__title-text--LineHeight)',
        fontSize: 'var(--pf-t--global--font--size--heading--sm)',
      },
      h2: {
        // Panel Group Heading: PatternFly's medium heading (odh-dashboard uses font--size--600,
        // 1.5rem, which reads larger than this console's own section titles).
        color: 'var(--pf-t--global--text--color--regular)',
        fontFamily: 'var(--pf-t--global--font--family--heading)',
        fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
        fontSize: 'var(--pf-t--global--font--size--heading--md)',
      },
    },
    palette: {
      // Not in odh-dashboard: Perses's getTheme spreads these options over its own, so this palette
      // replaces the one it built for the mode, and MUI would make it a light one without this.
      mode: theme,
      primary: {
        // Maps to PatternFly brand tokens: default, hover, clicked
        light: brandColor,
        main: brandColor,
        dark: brandHoverColor, // MUI uses 'dark' for hover
        contrastText: isDark ? t_color_gray_95.value : t_color_white.value,
      },
      secondary: {
        main: primaryTextColor,
        light: primaryTextColor,
        dark: primaryTextColor,
      },
      background: {
        default: primaryBackgroundColor,
        paper: primaryBackgroundColor,
      },
      text: {
        primary: primaryTextColor,
        secondary: primaryTextColor,
        disabled: primaryTextColor,
      },
    },
    components: {
      MuiTypography: {
        styleOverrides: {
          root: {
            // Custom Time Range Selector
            '&.MuiClock-meridiemText': {
              color: primaryTextColor,
            },
          },
        },
      },
      MuiSvgIcon: {
        styleOverrides: {
          root: {
            color: theme === 'dark' ? t_color_white.value : t_color_gray_95.value,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--pf-t--global--border--radius--medium)',
            borderColor: 'var(--pf-t--global--border--color--default)',
          },
        },
      },
      MuiCardHeader: {
        styleOverrides: {
          root: {
            '&.MuiCardHeader-root': {
              borderBottom: 'none',
              paddingBlockEnd: 'var(--pf-t--global--spacer--md)',
              paddingBlockStart: 'var(--pf-t--global--spacer--lg)',
              paddingLeft: 'var(--pf-t--global--spacer--lg)',
              paddingRight: 'var(--pf-t--global--spacer--lg)',
            },
          },
        },
      },
      MuiCardContent: {
        styleOverrides: {
          root: {
            '&.MuiCardContent-root': {
              borderTop: 'none',
              '&:last-child': {
                paddingBottom: 'var(--pf-t--global--spacer--lg)',
                paddingLeft: 'var(--pf-t--global--spacer--lg)',
                paddingRight: 'var(--pf-t--global--spacer--lg)',
              },
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          // Hide the notched outline (no floating label in border)
          notchedOutline: {
            border: 'none',
          },
          root: {
            // Bootstrap-style: full border on the root instead
            borderRadius: 'var(--pf-t--global--border--radius--small)',
            border: '1px solid',
            borderColor: 'var(--pf-t--global--border--color--default)',
            backgroundColor: 'var(--pf-t--global--background--color--primary--default)',
            '&:hover': {
              borderColor: 'var(--pf-t--global--border--color--hover)',
            },
            '&.Mui-focused': {
              borderColor: 'var(--pf-t--global--border--color--clicked)',
            },
          },
          input: {
            padding: 'var(--pf-t--global--spacer--sm) var(--pf-t--global--spacer--md)',
          },
        },
      },
      // Not in odh-dashboard: a time series' bottom legend is a 40px scroll box sized for two rows,
      // and dense list text's default 4px margins made each row 26px, half hiding the second.
      MuiListItemText: {
        styleOverrides: {
          dense: {
            marginTop: 1,
            marginBottom: 1,
          },
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          option: {
            paddingRight: 'var(--pf-t--global--spacer--lg) !important',
          },
        },
      },
      MuiSelect: {
        styleOverrides: {
          icon: {
            color: primaryTextColor,
          },
        },
      },
      MuiCheckbox: {
        styleOverrides: {
          root: {
            color: 'var(--pf-t--global--border--color--default)',
            '& .MuiSvgIcon-root': {
              color: 'inherit',
            },
            '&.Mui-checked': {
              color: 'var(--pf-t--global--color--brand--default)',
            },
            '&.MuiCheckbox-indeterminate': {
              color: 'var(--pf-t--global--color--brand--default)',
            },
          },
        },
      },
      MuiFormLabel: {
        styleOverrides: {
          root: {
            color: 'var(--pf-t--global--text--color--regular)',
            fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
            // Ensure consistent left alignment
            paddingLeft: 0,
            marginLeft: 0,
            '&.Mui-focused': {
              color: 'var(--pf-t--global--text--color--regular)',
            },
          },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: {
            color: 'var(--pf-t--global--text--color--regular)',
            fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
            // Position label above input (standard-like behavior)
            position: 'relative',
            transform: 'none',
            marginBottom: 'var(--pf-t--global--spacer--sm)',
            marginLeft: 0,
            paddingLeft: 0,
            fontSize: 'var(--pf-t--global--font--size--body--default)',
            '&.Mui-focused': {
              color: 'var(--pf-t--global--text--color--regular)',
            },
            '&.MuiInputLabel-shrink': {
              transform: 'none',
              fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
              marginLeft: 0,
              paddingLeft: 0,
            },
            '&.MuiInputLabel-outlined': {
              fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
            },
            '&.MuiInputLabel-outlined.MuiInputLabel-shrink': {
              fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
            },
          },
          shrink: {
            fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
          },
          outlined: {
            fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
          },
        },
      },
      MuiFormControl: {},
      MuiFormHelperText: {
        styleOverrides: {
          root: {
            marginLeft: 0,
          },
        },
      },
      MuiStack: {},
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            padding: 'var(--pf-t--global--spacer--lg)',
            fontSize: 'var(--pf-t--global--font--size--heading--md)',
            fontWeight: 'var(--pf-t--global--font--weight--heading--default)',
          },
        },
      },
      MuiDialogActions: {
        styleOverrides: {
          root: {
            padding: 'var(--pf-t--global--spacer--lg)',
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 'var(--pf-t--global--border--radius--large)',
          },
          root: {
            // Styles scoped to modal/dialog only
            '& .MuiStack-root': {
              paddingTop: t_global_spacer_md.value,
            },
            '& .MuiFormLabel-root, & .MuiInputLabel-root': {
              paddingLeft: 0,
              fontWeight: 'var(--pf-t--global--font--weight--body--bold)',
            },
            // Target the label that's a sibling of the PromQL expression editor
            '& .MuiStack-root:has([data-testid="promql_expression_editor"]) > .MuiInputLabel-root': {
              left: 0,
              marginLeft: 0,
            },
            // Only apply margin-top to icon button directly adjacent to PromQL expression editor
            '& [data-testid="promql_expression_editor"] + .MuiIconButton-root': {
              marginTop: t_global_spacer_md.value,
            },
            // CodeMirror editor text - always dark
            '& .cm-line': {
              color: t_color_gray_95.value,
            },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            // Use PatternFly inverse colors for tooltip
            backgroundColor: 'var(--pf-t--global--background--color--inverse--default)',
            // Override Typography color inside tooltip
            '& .MuiTypography-root': {
              color: 'var(--pf-t--global--text--color--inverse)',
            },
          },
          arrow: {
            color: 'var(--pf-t--global--background--color--inverse--default)',
          },
        },
      },
      MuiPickersDay: {
        styleOverrides: {
          root: {
            '&.Mui-selected': {
              // Lighter brand bg + dark text in dark theme, default brand bg + white text in light theme
              backgroundColor: 'var(--pf-t--global--color--brand--default)',
              color: 'var(--pf-t--global--text--color--on-brand--default)',
            },
          },
        },
      },
      // Bound year grid / typed absolute ranges (RHOAIENG-77625); Perses does not pass these props.
      MuiStaticDateTimePicker: {
        defaultProps: {
          minDate,
          maxDate,
        },
      },
      MuiDateTimeField: {
        defaultProps: {
          minDate,
          maxDate,
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 'var(--pf-t--global--border--radius--pill)',
          },
          containedPrimary: {
            // Text color for content on brand background
            color: 'var(--pf-t--global--text--color--on-brand--default)',
            backgroundColor: 'var(--pf-t--global--color--brand--default)',
            '&:hover': {
              backgroundColor: 'var(--pf-t--global--color--brand--hover)',
            },
            '&:active': {
              backgroundColor: 'var(--pf-t--global--color--brand--clicked)',
            },
          },
          outlinedPrimary: {
            color: 'var(--pf-t--global--color--brand--default)',
            borderColor: 'var(--pf-t--global--color--brand--default)',
            '&:hover': {
              borderColor: 'var(--pf-t--global--color--brand--hover)',
            },
          },
          outlinedSecondary: {
            // Icon-style buttons (refresh, etc.) - use small radius instead of pill
            borderRadius: 'var(--pf-t--global--border--radius--small)',
            borderColor: 'var(--pf-t--global--border--color--default)',
            '&:hover': {
              borderColor: 'var(--pf-t--global--border--color--hover)',
              backgroundColor: 'var(--pf-t--global--background--color--control--default)',
            },
          },
        },
      },
      MuiClock: {
        styleOverrides: {
          root: {
            // Clock pin (center dot)
            '& .MuiClock-pin': {
              backgroundColor: 'var(--pf-t--global--color--brand--default)',
            },
            // AM/PM buttons when selected
            '& .MuiClock-amButton.Mui-selected, & .MuiClock-pmButton.Mui-selected': {
              backgroundColor: 'var(--pf-t--global--color--brand--default)',
              '&:hover': {
                backgroundColor: 'var(--pf-t--global--color--brand--hover)',
              },
              // AM/PM text inside selected button - use inverse color
              '& .MuiClock-meridiemText': {
                color: 'var(--pf-t--global--text--color--inverse)',
              },
            },
          },
        },
      },
      MuiClockPointer: {
        styleOverrides: {
          root: {
            // Clock hand/pointer
            backgroundColor: 'var(--pf-t--global--color--brand--default)',
          },
          thumb: {
            // Clock pointer thumb (circle at the end)
            backgroundColor: 'var(--pf-t--global--color--brand--default)',
            borderColor: 'var(--pf-t--global--color--brand--default)',
            // Text color - inverse
            color: 'var(--pf-t--global--text--color--inverse)',
          },
        },
      },
      MuiClockNumber: {
        styleOverrides: {
          root: {
            // Selected clock number - use inverse text color
            '&.Mui-selected': {
              color: 'var(--pf-t--global--text--color--inverse)',
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            // Hide Query Viewer button (aria-label contains "query view")
            '&[aria-label*="query view" i]': {
              display: 'none',
            },
            // Hide panel notices (eg warning: PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "...")
            '&[aria-label="panel notices"]': {
              display: 'none',
            },
          },
        },
      },
    },
  };
};

/** The MUI and chart themes for the Perses components, built once per calendar year (for maxDate). */
export const patternFlyTheme = (
  theme: PatternFlyTheme = 'light',
  currentYear: number = new Date().getFullYear(),
): { muiTheme: Theme; chartsTheme: PersesChartsTheme } => {
  const muiTheme = getTheme(theme, {
    shape: {
      borderRadius: 6,
    },
    ...mapPatterflyThemeToMUI(theme, currentYear),
  });

  // PatternFly default text color as hex (ECharts does not resolve CSS variables)
  const defaultTextColor = theme === 'dark' ? t_color_white.value : t_color_gray_95.value;

  const chartsTheme: PersesChartsTheme = generateChartsTheme(muiTheme, {
    echartsTheme: {
      color: patternflyChartsMultiUnorderedPalette,
      // Not in odh-dashboard: ECharts draws text on a <canvas>, which can't resolve the CSS variable
      // the MUI theme's fontFamily is; the canvas then falls back to 10px sans-serif (axis labels,
      // in-chart text). PatternFly's body font as a literal stack, at its 12px minimum.
      textStyle: {
        fontFamily: t_global_font_family_body.value,
        fontSize: 12,
      },
      tooltip: {
        backgroundColor: 'var(--pf-t--global--background--color--inverse--default)',
      },
      // Not in odh-dashboard: Perses leaves 5px above the plot (theme-gen's grid.top, which the time
      // series panel doesn't override), and the y axis's top label, centred on that edge, then loses
      // its top to the canvas edge. Room for half a 12px label.
      grid: {
        top: 10,
      },
    },
    thresholds: {
      defaultColor: defaultTextColor,
      palette: defaultPaletteColors,
    },
  });

  return { muiTheme, chartsTheme };
};

export { patternflyChartsMultiUnorderedPalette };
