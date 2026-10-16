// Ported from krisv/ai-grid-cloud-provider-poc src/shared/components/TableRowTitleDescription.tsx at 62319b8.
// Adapted from frontend/src/components/table/TableRowTitleDescription.tsx
// opendatahub-io/odh-dashboard commit 8051fbbea117457b4da4074fb2856b732e6677a4

type Props = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  description?: React.ReactNode;
  truncateDescriptionLines?: number;
};

/** A table cell's title, with an optional subtitle and a clamped description. */
export const TableRowTitleDescription: React.FC<Props> = ({
  title,
  subtitle,
  description,
  truncateDescriptionLines,
}) => (
  <div>
    <div data-testid="table-row-title">{title}</div>
    {subtitle}
    {description && (
      <span
        data-testid="table-row-title-description"
        style={{
          color: 'var(--pf-t--global--text--color--subtle)',
          display: '-webkit-box',
          WebkitLineClamp: truncateDescriptionLines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {description}
      </span>
    )}
  </div>
);
