# Quantic Studio Canva — app para Windows

## Estrutura
```
main.js        processo principal: janela, rede, cofre de chaves, disco, atualização
preload.js     ponte mínima entre a tela e o sistema (sem Node na tela)
renderer/      a interface (index.html — o mesmo canvas que roda no navegador)
build/         ícone do app
.github/       robô que monta o instalador e publica as atualizações
```

## Configurar uma vez
1. Crie um repositório no GitHub chamado `quantic-studio-canva` e envie esta pasta.
2. Em `package.json`, troque `SEU_USUARIO_GITHUB` pelo seu usuário.
3. Para repositório **privado**, as atualizações exigem um token de leitura nos apps
   instalados — o mais simples é deixar o repositório de *releases* público
   (o código pode ficar em outro, privado).

## Publicar uma versão (instalador + atualização automática)
```
# 1. suba o número em package.json → "version": "1.0.1"
git commit -am "v1.0.1"
git tag v1.0.1
git push && git push --tags
```
O GitHub Actions monta `QuanticStudioCanva-Setup-1.0.1.exe` no Windows e publica no Releases.
Quem já tem o app instalado recebe o aviso **"Versão 1.0.1 pronta — Reiniciar e atualizar"**.
O app também instala sozinho a atualização quando é fechado.

## Rodar/montar no seu PC
```
npm install
npm start            # abre o app em modo desenvolvimento
npm run dist         # gera o instalador em dist/
```

## Segurança
- Tela isolada (contextIsolation + sandbox), sem acesso a Node, disco ou rede.
- Toda chamada de rede passa pelo processo principal: a chave de API só pode ir para
  `api.atlascloud.ai` e `api.apiverse.ai`; outros hosts só aceitam download (GET) sem chave.
- Chaves cifradas com o cofre do Windows (DPAPI) em `%APPDATA%\Quantic Studio Canva\keys.dat.json`.
- Navegação travada; links externos abrem no navegador padrão.
- Nomes de arquivo higienizados (sem `..`, sem nomes reservados do Windows); nada é sobrescrito.
- Permissões do sistema (câmera, microfone, localização) negadas.
- Uma única instância do app; tela travada é recarregada sem perder o projeto.

## Onde ficam os dados
- Vídeos: `Vídeos\Quantic Studio Canva` (troque pelo botão PASTA).
- Projeto em andamento e imagens: armazenamento interno do app (sobrevive a fechar/atualizar).
- Configurações: `%APPDATA%\Quantic Studio Canva\settings.json`.
