export function createOperationsWorkspace({ ui }) {
  const { React, ChannelsPage, EvaluationPage, ObservabilityPage, AutomationPage, DeliveryPage, StudioSubnav } = ui;
  const { createElement: h, useState } = React;
  function OperationalPage({ page }) {
    if (page === 'evaluation') return h(EvaluationPage);
    if (page === 'observability') return h(ObservabilityPage);
    if (page === 'channels') return h(ChannelsPage);
    return null;
  }
  
  function OperationsWorkspace({ scheduleRemote }) {
    const [tab, setTab] = useState('delivery');
    return h('div', null,
      h(StudioSubnav, { value: tab, onChange: setTab, items: [{ id: 'delivery', label: '构建与部署' }, { id: 'automation', label: '自动化' }, { id: 'evaluation', label: '评测' }, { id: 'observability', label: '观测' }, { id: 'channels', label: 'Channels' }] }),
      tab === 'delivery' ? h(DeliveryPage) : tab === 'automation' ? h(AutomationPage, { scheduleRemote }) : h(OperationalPage, { page: tab }));
  }
  return { OperationalPage, OperationsWorkspace };
}
