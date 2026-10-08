/** Present only actual conversations attached to this cloud Agent's bot. */
export function scheduleDeliveryTargets(agentId, channels, bindings) {
  return channels.filter(channel => channel.AgentId === agentId && channel.Enabled === true
    && !channel.ConnectorWorkspaceId && ['wps-xiezuo', 'feishu'].includes(channel.Channel)).flatMap(channel =>
    bindings.filter(binding => binding.AgentId === agentId && binding.Channel === channel.Channel
      && binding.ChannelAccountId === channel.ChannelAccountId && ['dm', 'group'].includes(binding.ChatType))
      .filter(binding => binding.ChatType === 'group' ? binding.ChatId || binding.GroupId : binding.ChatId || binding.PeerId)
      .filter(binding => channel.Channel !== 'wps-xiezuo' || binding.ChatId || (binding.ChatType === 'group' && binding.GroupId))
      .map(binding => ({ channelConfigId: channel.Id, bindingId: binding.Id,
        label: `${channel.Channel === 'wps-xiezuo' ? 'WPS' : '飞书'} · ${channel.ChannelAccountId} · ${binding.ChatType === 'group' ? '群聊' : '私聊'} ${binding.ChatId || binding.GroupId || binding.PeerId}` })));
}
