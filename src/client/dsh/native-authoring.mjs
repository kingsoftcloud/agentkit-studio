export function createNativeAuthoringButton({ React, authoring, buttonStyle }) {
  const { createElement: h, useEffect } = React;
  return function NativeAuthoringButton({ inputActions }) {
    useEffect(() => authoring.subscribe(inputActions), [inputActions]);
    return h('button', {
      type: 'button', disabled: !inputActions, title: '新建会话，通过多轮对话完善 Agent 草稿',
      onClick: () => authoring.request(),
      style: { ...buttonStyle(), fontSize: '11px', padding: '5px 8px', whiteSpace: 'nowrap' },
    }, '创建 Agent');
  };
}
