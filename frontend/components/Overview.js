// "What the AI can and cannot do": a status per tool or skill (tested, done,
// planned), shown at the top of Setup -> Tools and Setup -> Skills. Open or
// closed persists per user under the key the page passes.
import React from 'react';
import * as S from './styles';

const STATUS = {
  tested: { color: S.GREEN, text: 'tested', help: 'built, and tried with real questions on the AI server' },
  done: { color: S.BLUE, text: 'done', help: 'built, not yet tried in real answers' },
  planned: { color: S.GREY, text: 'planned', help: 'not built yet' }
};

function Overview({ title, items, usePageState, stateKey }) {
  const [open, setOpen] = usePageState(stateKey, true, [true, false]);
  const count = k => items.filter(i => i.status === k).length;
  return (
    <div style={{ marginBottom: '15px' }} data-testid="overview">
      <div style={{ ...S.heading, marginTop: 0, cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} {title}: {count('tested')} tested, {count('done')} done, {count('planned')} planned
      </div>
      {open && (
        <div style={S.tableWrapper}>
          <table style={S.table}>
            <tbody>
              {items.map(i => (
                <tr key={i.name}>
                  <td style={{ ...S.td, padding: '6px 12px', width: '90px' }}><span style={S.chip(STATUS[i.status].color)} title={STATUS[i.status].help}>{STATUS[i.status].text}</span></td>
                  <td style={{ ...S.td, padding: '6px 12px' }}>{i.name}</td>
                  <td style={{ ...S.td, padding: '6px 12px', color: '#666' }}>{i.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ ...S.small, padding: '6px 12px' }}>Tested: {STATUS.tested.help}. Done: {STATUS.done.help}. Planned: {STATUS.planned.help}.</div>
        </div>
      )}
    </div>
  );
}

export default Overview;
