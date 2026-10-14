import { operationalId, operationalDate } from '../state/operational-data.mjs';
import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createOperationalComponents({ ui }) {
  const { React, Pill, pagerButtonStyle, buttonStyle, OperationalPanel, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h } = React;
  function operationalStatus(value) {
    const status = String(value || 'unknown').toUpperCase();
    const tone = ['SUCCEEDED', 'SUCCESS', 'PASSED', 'COMPLETED', 'READY', 'CONNECTED', 'ENABLED', 'ONLINE'].includes(status) ? 'accent' : ['FAILED', 'ERROR', 'CANCELLED', 'REJECTED', 'OFFLINE'].includes(status) ? 'signal' : 'neutral';
    return h(Pill, { tone }, status.toLowerCase());
  }
  
  function OperationalTable({ columns, rows, empty = '暂无数据', onRowClick }) {
    const header = h('thead', null,
      h('tr', { style: { position: 'sticky', top: 0, zIndex: 1, textAlign: 'left', color: BRAND.inkMuted, background: BRAND.canvas } },
        columns.map(column => h('th', { key: column.id, style: { padding: '11px 12px', fontWeight: 750, whiteSpace: 'nowrap', borderBottom: '1px solid ' + BRAND.border } }, column.label))));
    const body = rows.length
      ? rows.map((row, index) => h('tr', { key: operationalId(row, String(index)), onClick: onRowClick ? () => onRowClick(row) : undefined, style: { cursor: onRowClick ? 'pointer' : 'default', borderBottom: '1px solid ' + BRAND.border } }, columns.map(column => h('td', { key: column.id, style: { padding: '11px 12px', color: BRAND.ink, verticalAlign: 'top', maxWidth: column.maxWidth || undefined } }, column.cell ? column.cell(row) : String(row?.[column.id] ?? '—')))))
      : h('tr', null, h('td', { colSpan: columns.length, style: { padding: '28px 14px', color: BRAND.inkMuted, textAlign: 'center' } }, empty));
    return h('div', { style: { overflow: 'auto', maxHeight: 'min(58vh, 560px)', border: '1px solid ' + BRAND.border, borderRadius: '12px', background: BRAND.surface } },
      h('table', { style: { width: '100%', minWidth: Math.max(680, columns.length * 140) + 'px', borderCollapse: 'collapse', fontSize: '12px' } }, header, h('tbody', null, body)));
  }
  
  function OperationalPager({ page, pageSize, total, onChange }) {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    return h('div', { 'data-studio-pager': 'true', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '10px', padding: '4px 0', color: BRAND.inkMuted, fontSize: '11px' } },
      h('span', null, total ? `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} / ${total}` : '0 条'),
      h('div', { style: { display: 'flex', gap: '6px', flexShrink: 0 } },
        h('button', { type: 'button', 'aria-label': '运行中心上一页', disabled: page <= 0, onClick: () => onChange(Math.max(0, page - 1)), style: pagerButtonStyle(page <= 0) }, '上一页'),
        h('button', { type: 'button', 'aria-label': '运行中心下一页', disabled: page >= pageCount - 1, onClick: () => onChange(Math.min(pageCount - 1, page + 1)), style: pagerButtonStyle(page >= pageCount - 1) }, '下一页')));
  }
  
  function OperationalToolbar({ children, onRefresh, busy }) {
    return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, children),
      h('button', { type: 'button', onClick: onRefresh, disabled: busy, style: { ...buttonStyle(), background: BRAND.surface } }, busy ? '读取中…' : '刷新'));
  }
  
  function OperationalBars({ buckets = [] }) {
    const values = Array.isArray(buckets) ? buckets.slice(-24) : [];
    if (!values.length) return null;
    const peak = Math.max(1, ...values.map(item => Number(item?.runs || item?.count || 0)));
    return h(OperationalPanel, { title: '运行趋势', detail: 'Host Trace Store 返回的时间桶；没有上报时不绘制估算数据。' },
      h('div', { style: { display: 'flex', alignItems: 'end', gap: '4px', height: '92px', padding: '12px 14px 14px', overflowX: 'auto' } },
        values.map((item, index) => {
          const runs = Number(item?.runs || item?.count || 0);
          const completed = Number(item?.completed || item?.succeeded || 0);
          const height = Math.max(4, Math.round((runs / peak) * 58));
          return h('div', { key: `${item?.startedAt || item?.at || index}`, title: `${operationalDate(item?.startedAt || item?.at)} · ${runs} 次运行 · ${completed} 次完成`, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'end', gap: '4px', minWidth: '18px', height: '66px' } },
            h('span', { style: { width: '12px', height: `${height}px`, borderRadius: '4px 4px 2px 2px', background: completed === runs ? BRAND.primaryFill : BRAND.accentSoft, border: '1px solid ' + BRAND.primaryFill } }),
            index === 0 || index === values.length - 1 ? h('small', { style: { color: BRAND.inkMuted, fontSize: '9px', whiteSpace: 'nowrap' } }, operationalDate(item?.startedAt || item?.at).slice(0, 5)) : null);
        })));
  }
  return { operationalStatus, OperationalTable, OperationalPager, OperationalToolbar, OperationalBars };
}
