// Every table of this module, sorted with core's shared table sorting (core
// 0.1.223: coreApi.useSortedRows + coreApi.ui.SortHeader): two buttons per
// column (ascending, descending), natural order, and the choice kept per user
// under <rememberAs>.sort. No home-made sorting anywhere else.
//
// head: [{ key, label, style? }] in column order. A key with an entry in
// `columns` gets the sort buttons; a key without one (actions) is a plain
// header. columns: core's column definitions, given raw values (timestamps,
// numbers), not formatted text.
import React from 'react';
import * as S from './styles';

function SortedTable({ coreApi, rows, columns, rememberAs, defaultSort = null, head, rowKey, renderRow, wrapperStyle, testId }) {
  const table = coreApi.useSortedRows(rows, columns, { rememberAs, defaultSort });
  const { SortHeader } = coreApi.ui;
  return (
    <div style={{ ...S.tableWrapper, ...(wrapperStyle || {}) }} data-testid={testId}>
      <table style={S.table}>
        <thead style={S.thead}>
          <tr>
            {head.map(h => (columns[h.key] && SortHeader
              ? <SortHeader key={h.key} table={table} column={h.key} label={h.label} style={{ ...S.th, ...(h.style || {}) }}>{h.label}</SortHeader>
              : <th key={h.key} style={{ ...S.th, ...(h.style || {}) }}>{h.label}</th>))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(r => <React.Fragment key={rowKey(r)}>{renderRow(r)}</React.Fragment>)}
        </tbody>
      </table>
    </div>
  );
}

export default SortedTable;
