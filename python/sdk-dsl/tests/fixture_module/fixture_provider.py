"""Fixture module for the bridge integration tests.

Carries one `@service` class with a `@provide_method`, one `@tool`, and one
`@on` listener whose body writes to stdout (so the test asserts the runtime's
stdout → `bridge/log` proxying).
"""

from dataclasses import dataclass

from dsh_bridge import on, provide_method, service, tool


@service(name="echo")
@dataclass
class EchoProvider:
    greeting: str = "hello"

    @provide_method(timeout_ms=1_000)
    def echo(self, text: str) -> str:
        return f"{self.greeting}: {text}"

    @provide_method()
    def boom(self) -> None:
        raise ValueError("fixture boom")


@tool(name="shout", description="Upper-case a string.", parameters={"text": {"type": "string"}})
def shout(text: str) -> dict:
    return {"text": text.upper()}


@on("session/event", mode="emit")
def audit(event: str, payload: dict) -> None:
    if payload.get("type") == "tool/call":
        print(f"audit: tool call {payload.get('data', {}).get('name', '?')}")