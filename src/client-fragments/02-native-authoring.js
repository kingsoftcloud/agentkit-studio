    const authoring = createNativeAuthoring({ writeConversationAgent });
    const { openAgentAuthoring, seedAgentAuthoring } = authoring;
    const NativeAuthoringButton = createNativeAuthoringButton({ React, authoring, buttonStyle });
