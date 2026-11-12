import { OPERATIONS_FOCUS_KEY, readOperationsFocus } from '../operations-focus.mjs';

export function createOperationsWorkspace({
  ui: { React: { createElement: h, useState, useEffect }, ChannelsPage, EvaluationPage, ObservabilityPage, AutomationPage, DeliveryPage, StudioSubnav },
  window = globalThis.window,
}) {
  function OperationalPage({ page }) {
    if (page === 'evaluation') return h(EvaluationPage);
    if (page === 'observability') return h(ObservabilityPage);
    if (page === 'channels') return h(ChannelsPage);
    return null;
  }

  function OperationsWorkspace({ scheduleRemote }) {
    const [tab, setTab] = useState('delivery');
    const [focus, setFocus] = useState(() => readOperationsFocus(window));
    useEffect(() => {
      const receive = event => { setFocus(event.detail); setTab('delivery'); };
      window.addEventListener(OPERATIONS_FOCUS_KEY, receive);
      return () => window.removeEventListener(OPERATIONS_FOCUS_KEY, receive);
    }, []);
    return h('div', null,
      h(StudioSubnav, { variant: 'segmented', value: tab, onChange: setTab, items: [{ id: 'delivery', label: '构建与部署' }, { id: 'automation', label: '自动化' }, { id: 'evaluation', label: '评测' }, { id: 'observability', label: '观测' }, { id: 'channels', label: 'Channels' }] }),
      tab === 'delivery' ? h(DeliveryPage, { focus }) : tab === 'automation' ? h(AutomationPage, { scheduleRemote }) : h(OperationalPage, { page: tab }));
  }
  return { OperationalPage, OperationsWorkspace };
}
