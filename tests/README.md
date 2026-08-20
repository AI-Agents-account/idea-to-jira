# Test assets

`fixtures/` contains synthetic, public-safe examples. Runtime unit tests live beside the
plugin in `packages/idea-to-jira-plugin/tests/`. Add integration tests here when a real
Jira adapter exists; they must use a disposable test project and injected CI secrets.
