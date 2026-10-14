import { BRAND as DEFAULT_BRAND } from '../theme.mjs';

export function createScheduleDelivery({ ui, hostRemote }) {
  const { React, inputStyle, Pill, BRAND = DEFAULT_BRAND } = ui;
  const { createElement: h, useEffect, useState } = React;
  function ScheduleDeliveryPicker({ agentId, mode, target, supported, onChange }) {
    const [catalog, setCatalog] = useState({ loading: false, items: [], error: '' });
    useEffect(() => {
      let active = true;
      if (mode !== 'channel' || !supported || !agentId) return undefined;
      setCatalog({ loading: true, items: [], error: '' });
      hostRemote.scheduleDeliveryTargets(agentId).then(result => {
        if (active) setCatalog({ loading: false, items: result?.items || [], error: '' });
      }).catch(error => { if (active) setCatalog({ loading: false, items: [], error: error?.message || '渠道会话读取失败' }); });
      return () => { active = false; };
    }, [agentId, mode, supported]);
    const key = value => value ? `${value.channelConfigId}/${value.bindingId}` : '';
    const selected = key(target);
    return h('fieldset', { style: { margin: 0, padding: '12px', border: '1px solid ' + BRAND.border, borderRadius: '10px', display: 'grid', gap: '10px' } },
      h('legend', { style: { color: BRAND.inkMuted, fontSize: '12px' } }, '结果去向'),
      h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', color: BRAND.ink, fontSize: '12px' } },
        h('label', null, h('input', { type: 'radio', name: 'schedule-delivery', checked: mode !== 'channel', onChange: () => onChange('record', null) }), ' 仅保存执行记录'),
        h('label', null, h('input', { type: 'radio', name: 'schedule-delivery', checked: mode === 'channel', disabled: !supported && mode !== 'channel', onChange: () => onChange('channel', null) }), ' 发送到渠道会话')),
      !supported ? h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '云端渠道投递尚未就绪，执行结果仍可保存在记录中。') : null,
      mode === 'channel' ? h(React.Fragment, null,
        h('select', { 'aria-label': '收件会话', value: selected, disabled: catalog.loading || !supported,
          onChange: event => { const item = catalog.items.find(value => key(value) === event.target.value); onChange('channel', item ? { channelConfigId: item.channelConfigId, bindingId: item.bindingId } : null); }, style: inputStyle() },
          h('option', { value: '' }, catalog.loading ? '正在读取渠道会话…' : '选择收件会话'),
          selected && !catalog.items.some(item => key(item) === selected) ? h('option', { value: selected, disabled: true }, '原收件会话（暂不可用）') : null,
          catalog.items.map(item => h('option', { key: key(item), value: key(item) }, item.label))),
        h('span', { style: { color: BRAND.inkMuted, fontSize: '11px', lineHeight: 1.6 } }, '先在 Channels 绑定云端 Agent，并与机器人完成一次对话。仅发送给这里选择的会话；发送失败不会重跑任务。'),
        catalog.error ? h('span', { role: 'alert', style: { color: BRAND.danger, fontSize: '12px' } }, catalog.error) : null,
        !catalog.loading && !catalog.error && !catalog.items.length && supported ? h('span', { style: { color: BRAND.inkMuted, fontSize: '11px' } }, '暂无可投递的 WPS 或飞书会话。') : null) : null);
  }
  
  function ScheduleDeliveryResult({ item }) {
    const labels = { waiting_result: '等待执行结果', pending: '待投递', queued: '待发送', sending: '发送中',
      retrying: '等待重试', delivered: '已送达', failed: '投递失败', unknown: '送达结果待确认', not_sent: '未投递' };
    const reasons = {
      delivery_target_unavailable: '原渠道或会话已不可用，请检查绑定。',
      delivery_target_changed: '机器人或收件会话已变化，请重新选择收件会话。',
      delivery_conversation_missing: '尚未取得会话信息，请先与机器人对话。',
      channel_delivery_unavailable: '渠道服务暂不可用，正在等待恢复。',
      result_text_missing_or_too_large: '本轮没有可发送的文本，或结果超过长度限制。',
      delivery_outcome_unknown: '发送进程未确认结果，请在收件会话核对。',
    };
    if (!item?.deliveryState && !item?.resultText) return null;
    return h('div', { style: { display: 'grid', gap: '6px', fontSize: '11px', color: BRAND.inkMuted, marginTop: '6px' } },
      item.deliveryState ? h('div', null, '渠道投递：', h(Pill, { tone: ['failed', 'unknown'].includes(item.deliveryState) ? 'signal' : item.deliveryState === 'delivered' ? 'accent' : 'neutral' }, labels[item.deliveryState] || item.deliveryState)) : null,
      item.deliveryError ? h('span', { title: item.deliveryError }, reasons[item.deliveryError] || '渠道未确认送达，请检查渠道连接和执行记录。') : null,
      item.deliveryState === 'unknown' ? h('span', null, '请在收件会话确认；系统不会自动重复发送。') : null,
      item.resultText ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, '查看执行结果'),
        h('div', { style: { color: BRAND.ink, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '260px', overflow: 'auto', padding: '8px 0', lineHeight: 1.6 } }, item.resultText)) : null);
  }
  return { ScheduleDeliveryPicker, ScheduleDeliveryResult };
}
