"""Development-only oracle generation; never used by install/build/runtime.

Usage: python3.12 scripts/generate-native-provider-compat-fixtures.py /path/to/ksadk-python
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import types

sys.dont_write_bytecode = True
root = pathlib.Path(sys.argv[1]).resolve()
reference = "355059d78e47ed764bbdb3606304cdf34e9838a3"
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() == reference
assert not subprocess.check_output(["git", "diff", "HEAD", "--", "ksadk/model_proxy/compat.py", "ksadk/model_proxy/transform.py"], cwd=root)
# Load only these pure modules, without importing Studio's optional SDK graph.
for name, path in [("ksadk", root / "ksadk"), ("ksadk.model_proxy", root / "ksadk/model_proxy")]:
    package = types.ModuleType(name)
    package.__path__ = [str(path)]
    sys.modules[name] = package
from ksadk.model_proxy import compat

specs = [
    ("strict", "strict-openai", "glm-5.3-flash", "task", "medium", None, True),
    ("unknown", "permissive", "unknown-model", "task", "xhigh", None, True),
    ("glm-tools", "zai", "glm-5.3-flash", "task", "medium", None, True),
    ("glm-explicit-on", "zai", "glm-5.3-flash", "task", "none", "enabled", True),
    ("zai-small-budget", "zai", "glm-5.2", "task", None, None, False),
    ("summary-52", "kspmas-gateway", "glm-5.2", "compaction", None, None, False),
    ("summary-53", "kspmas-gateway", "glm-5.3-flash", "compaction", None, None, False),
    ("summary-deepseek", "kspmas-gateway", "deepseek-v4-flash", "compaction", None, None, False),
    ("summary-explicit", "kspmas-gateway", "glm-5.3-flash", "compaction", "high", None, False),
    ("kimi", "kspmas-gateway", "kimi-k2.7-code", "task", "high", None, True),
    ("kimi-fast", "moonshot", "kimi-k2.7-code-highspeed", "task", "high", None, True),
    ("qwen", "permissive", "qwen3.7-plus", "task", "xhigh", None, True),
    ("fable", "permissive", "claude-fable-5-1", "task", "low", "disabled", True),
    ("haiku", "permissive", "claude-haiku-5-5", "task", "medium", "disabled", True),
    ("deepseek", "deepseek", "deepseek-v4-flash", "task", None, None, True),
    ("delegate-glm", "kspmas-gateway", "glm-5.3-flash", "task", None, None, True),
    ("delegate-explicit", "zai", "glm-5.3-flash", "task", "high", None, True),
    ("delegate-strict", "strict-openai", "glm-5.3-flash", "task", None, None, True),
]
cases = []
for case_id, rule, model, purpose, requested, mode, tools in specs:
    p = compat.compat_profile(rule, model=model)
    payload = dict(model=model, stream=True, n=1, max_tokens=1024,
        messages=[dict(role="assistant", content="old answer", reasoning_content="private replay")],
        stream_options=dict(include_usage=True, other=True))
    if requested is not None:
        payload["reasoning_effort"] = requested
    if tools:
        payload.update(tools=[dict(type="function", function=dict(name="read", parameters=dict(type="object")))], tool_choice="required")
    controller = case_id.startswith("delegate-")
    if controller:
        payload["tools"][0]["function"]["name"] = "delegate_task"
    before = json.loads(json.dumps(payload))
    profile = {}
    if controller:
        profile["controllerReasoningPolicy"] = "disclosed-delegate/v1"
    if requested is not None:
        profile["reasoningEffort"] = requested
    if mode is not None:
        profile["thinkingMode"] = mode
    effective_requested = requested
    if controller and requested is None:
        effective_requested = compat.default_delegation_reasoning_effort(p, model=model)
    effort = compat.request_reasoning_effort(p, model=model, purpose=purpose, requested=effective_requested)
    if effort is not None:
        payload["reasoning_effort"] = effort
    if tools:
        payload["tool_choice"] = compat.project_tool_choice(payload["tool_choice"], p)
    if mode == "enabled":
        payload = compat.with_thinking_enabled(payload, p)
    elif mode == "disabled" or compat.request_thinking_disabled(p, model=model, purpose=purpose, requested=requested) or compat.should_disable_thinking(p, tools_present=tools, max_output_tokens=1024, reasoning_effort=effort):
        payload = compat.with_thinking_disabled(payload, p, reasoning_effort=effort)
    cases.append(dict(id=case_id, rule=rule, model=model, purpose=purpose, profile=profile,
        payload=before, expected=compat.apply_chat_compat(payload, p, model=model)))

sources = [root / "ksadk/model_proxy/compat.py", root / "ksadk/model_proxy/transform.py"]
output = pathlib.Path(__file__).resolve().parent.parent / "packages/agentkit-harness/test/fixtures/native-provider-compat.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(dict(reference=reference,
    sourceSha256={str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
    cases=cases), ensure_ascii=False, indent=2) + "\n")
print(f"Wrote {len(cases)} Python reference cases to {output}")
