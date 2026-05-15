---
name: llm-config
description: Configure, validate, and test LLM provider connections. Apply when user wants to add/change LLM provider, test connectivity, or troubleshoot LLM configuration issues.
---

# LLM Configuration Skill

## Config File Location
`~/.cinematic-studio/config.yaml` (user config, never in project dir)

## Validation Steps
1. Read current config from `config/default.yaml`
2. Check provider enum is valid
3. Test API connectivity with `health_check()`
4. Verify model is available for that provider
5. Write validated config

## Provider Quick Reference

| Provider   | Needs API Key | Needs Base URL    | Best Model           |
|------------|---------------|-------------------|----------------------|
| openai     | YES           | No (default)      | gpt-4o               |
| anthropic  | YES           | No (default)      | claude-sonnet-4-6    |
| ollama     | No            | YES (localhost)   | llama3:70b           |
| lmstudio   | No            | YES (localhost)   | (depends on load)    |
| groq       | YES           | No (default)      | llama-3.3-70b        |

## Health Check Pattern
```python
async def test_llm_connection(config: LLMConfig) -> TestResult:
    adapter = get_adapter(config)
    try:
        ok = await asyncio.wait_for(adapter.health_check(), timeout=10.0)
        return TestResult(success=ok, latency_ms=elapsed)
    except asyncio.TimeoutError:
        return TestResult(success=False, error="Connection timeout (>10s)")
    except Exception as e:
        return TestResult(success=False, error=str(e))
```

## Env Var Override Pattern
Config values can reference env vars: `api_key: ${OPENAI_API_KEY}`
Resolved in `src/core/config.py` at load time using `os.environ.get()`
