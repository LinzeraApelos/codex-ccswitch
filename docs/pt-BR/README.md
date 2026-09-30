# CCswitch para Codex

Este projeto comunitário mostra modelos nativos e modelos externos selecionados no mesmo seletor do Codex Desktop. Um proxy local encaminha IDs `openrouter/<id-do-modelo>` ao OpenRouter, `cheaper/<id-do-modelo>` ao Cheaper Inference e IDs sem prefixo ao serviço nativo do Codex. Não é uma função oficial da OpenAI nem uma instalação universal de um clique. A [documentação principal em inglês](../../README.md) é a referência para alterações futuras.

**Atenção:** se você definir `ccswitch` como provedor global, **até os modelos nativos dependerão do proxy local**. Se ele parar, reinicie o proxy ou restaure sua configuração anterior. Teste primeiro num perfil separado do CLI. Revise o código antes de executá-lo e nunca cole sua API key no chat ou no GitHub.

## Prompt de quatro linhas

Abra o [prompt em português](PROMPT.md), substitua os IDs e cole-o no seu Codex. O agente deve pedir a chave por uma entrada local que não exiba os caracteres, fazer backup, testar uma tarefa real com ferramenta e explicar como desfazer.

## Instalação manual (Node.js 22+, Codex CLI/Desktop)

1. Faça backup de `~/.codex/config.toml` e confirme que sua versão aceita provedores personalizados e `model_catalog_json`.
2. Clone o repositório. Copie `models.example.json` para `models.json`, ignorado pelo Git. Troque os exemplos pelos IDs exatos e limites reais de contexto disponíveis no seu provedor. Um modelo aparecer no seletor **não** garante que ferramentas, imagens, compaction ou streaming funcionem.
3. Guarde `OPENROUTER_API_KEY=...` e/ou `CHEAPER_INFERENCE_API_KEY=...` em `~/.codex/ccswitch-keys.env`, fora do repositório, com acesso restrito ao seu usuário. Variáveis de ambiente ou `.env` local (ignorado pelo Git) também funcionam. Nunca publique a chave.
4. Abra o Codex uma vez para preencher o cache de modelos nativos. Execute `npm run catalog` nesta pasta. Será criado `~/.codex/ccswitch-combined-model-catalog.json`. Reinicie o Codex após mudar a lista.
5. Execute `npm run proxy` e consulte `http://127.0.0.1:8787/healthz`. Verifique `ok: true` e o indicador `configured` do seu provedor. O proxy escuta somente no endereço reservado de **loopback** `127.0.0.1`, que não é um IP público ou pessoal. Teste uma tarefa externa simples, outra com ferramenta e uma tarefa nativa.
6. Para testar sem mudar o provedor global, crie `~/.codex/ccswitch.config.toml` com os caminhos e modelo corretos:

```toml
model_provider = "ccswitch"
model = "openrouter/z-ai/glm-5.3-flash"
model_catalog_json = "/CAMINHO/ABSOLUTO/PARA/.codex/ccswitch-combined-model-catalog.json"

[model_providers.ccswitch]
name = "CCswitch local"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

Execute `codex --profile ccswitch`. As versões atuais do Codex usam um arquivo `<nome>.config.toml` separado, não a tabela antiga `[profiles.<nome>]` no arquivo principal. Consulte a [documentação oficial de perfis](https://developers.openai.com/codex/config-advanced).

7. Só depois do teste, se aceitar a dependência do proxy para o seletor do Desktop, faça outro backup de `config.toml`. Adicione `model_provider = "ccswitch"` e o caminho absoluto em `model_catalog_json` **antes de qualquer tabela TOML**; acrescente a tabela `[model_providers.ccswitch]` sem duplicá-la. Preserve o modelo nativo padrão e todas as outras opções. Reinicie o aplicativo e teste modelos nativos e externos. Configure inicialização automática no seu usuário apenas depois de validar também a reversão; o projeto não instala serviço em segundo plano sozinho.

## Reversão e segurança

Restaure o backup de `config.toml`, reinicie o Codex, pare o proxy e remova eventual tarefa de inicialização. Isso não apaga conversas nem cancela créditos externos.

O repositório não contém IP público, endereço de servidor pessoal, chave SSH, API key ou caminho privado. A chave externa é enviada apenas ao provedor correspondente; a autenticação nativa segue apenas para o serviço nativo. Ainda assim, processos locais do mesmo usuário podem potencialmente acessar um serviço local. Não exponha a porta à rede. O uso externo tem cobrança própria, e cada modelo precisa ser testado quanto a ferramentas e compatibilidade.

OpenAI Docs: [provedores e perfis](https://developers.openai.com/codex/config-advanced), [referência de configuração](https://developers.openai.com/codex/config-reference).
