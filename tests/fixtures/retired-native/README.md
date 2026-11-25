# Retired native runtime fixtures

These modules retain Studio's pre-cutover in-process runtime for compatibility
tests. The shipping Studio Host connects to an independently installed Harness.
Results from this fixture directory describe the historical implementation.

Use the packed independent workspace verifier to check the shipping Host,
including separate Harness connections, cold reconstruction and A2A projection.
When equivalent production coverage exists for a historical test, remove the
test and any fixture modules it was the last to use.
