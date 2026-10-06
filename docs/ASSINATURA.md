# Contratos em documento e assinatura eletrônica

> **Aviso:** isto é documentação técnica, não parecer jurídico. Os modelos e as conclusões abaixo precisam ser revistos por advogado
> antes de uso com clientes reais. O sistema deixa isso explícito: o modelo inicial é marcado "sem validação jurídica" e a aprovação de
> documentos de modelo não revisado exige uma confirmação consciente, que fica na auditoria.

## O que existe hoje

- **Modelos** com variáveis (`{{locador.nome}}`, `{{aluguel.valor_extenso}}` etc.), versionados; editar o texto sobe a versão e **zera a revisão jurídica**.
- **Documento a partir do contrato de locação:** o sistema preenche os dados reais (partes, imóvel, valor também por extenso, prazo, encargos). **Nada é inventado**: dado que falta
  (por exemplo, CPF do inquilino) permanece como `{{campo}}`, é apontado e bloqueia o envio para revisão.
- **Versões imutáveis** com hash SHA-256 e observação de quem mudou o quê. O texto (que contém CPF/CNPJ) é guardado **criptografado**.
- **Aprovação em duas pessoas:** quem redigiu não aprova (exceto a diretoria); só quem administra locação aprova, envia, reabre ou cancela.
- **PDF gerado na aprovação**, guardado fora do banco e endereçado pelo hash. Toda leitura **reconfere o hash**: arquivo alterado no disco não é entregue.
- **Signatários e coleta de assinaturas em modo manual:** o sistema **não assina por ninguém**. A pessoa registra quem assinou, com a observação de como foi feito
  (ex.: "gov.br em 06/10"), e anexa o PDF assinado (validado pelo conteúdo, não pelo nome; até 15 MB). O documento só vira **Assinado** quando todos os
  signatários estiverem registrados **e** houver um PDF assinado anexado.
- **Auditoria** de cada passo (criação, edição, aprovação, envio, download, assinatura declarada, anexo, cancelamento).

## O que NÃO existe

Integração com provedor de assinatura (envio do link ao signatário, coleta e validação da assinatura, carimbo de tempo, trilha do provedor), assinatura dentro do Aimob,
verificação de certificados ICP-Brasil, notificações automáticas aos signatários, modelos além do inicial de locação e preenchimento de dados de fiador.
A interface de provedor está definida (ver abaixo) e a escolha do provedor é uma decisão pendente.

## Achados legais que desenharam o produto (pesquisa de 06/10/2026)

| Tema | O que apurei | Fonte / situação |
|---|---|---|
| Níveis de assinatura | A Lei 14.063/2020, art. 4º, classifica a assinatura eletrônica em **simples, avançada e qualificada** | confirmado em resultados de pesquisa; o texto no Planalto não carregou (erro de conexão), então os artigos devem ser conferidos no texto oficial |
| Validade entre as partes | Certificado ICP-Brasil **não é o único meio** de comprovar autoria e integridade, desde que **as partes admitam** o meio como válido (MP 2.200-2/2001, art. 10, §2º) | por isso o modelo inicial traz a cláusula de reconhecimento da assinatura eletrônica |
| Registro em cartório | Decisões do **CSM-SP** (2024 e 2025) mantêm a recusa de registrar na matrícula **contrato de locação com cláusula de vigência** assinado sem assinatura qualificada (ICP-Brasil); a avançada não bastou para o registro | fontes secundárias, abaixo; há **debate jurisprudencial** e a regra pode variar por estado |

Consequências no produto:
1. O documento registra o **nível de assinatura pretendido** (simples, avançada ou qualificada) e mostra um aviso permanente de que, para **registro na matrícula**, cartórios podem exigir a qualificada.
2. Nenhum texto do sistema promete "validade jurídica" genérica.
3. Quem precisa de registro (ex.: cláusula de vigência para valer contra adquirente) deve usar assinatura **qualificada**; para uso entre locador e locatário a avançada, aceita pelas partes, é a prática de mercado, sujeita à análise do seu jurídico.

Fontes consultadas (secundárias; confira no texto oficial e com seu advogado):
- [CSM-SP: instrumento particular de locação assinado por plataforma privada não é registrável (CNB-SP, 12/2024)](https://cnbsp.org.br/2024/12/02/29-tabelionato-de-notas-csm-sp-confirma-que-nao-e-registravel-instrumento-particular-de-locacao-assinado-pela-plataforma-docusign/)
- [TJ-SP mantém óbice a registro de locação eletrônica sem assinatura qualificada (CNB-SP, 12/2025)](https://cnbsp.org.br/2025/12/01/dje-processo-n-1117826-50-2025-8-26-0100-tj-sp-mantem-obice-a-registro-de-contrato-de-locacao-eletronico-sem-assinatura-digital-qualificada-icp-brasil/)
- [Decisão do CSM-SP sobre locação não residencial com cláusula de vigência (Portal Dori, 12/2025)](https://portaldori.com.br/2025/12/19/csm-sp-direito-registral-duvida-registral-contrato-de-locacao-nao-residencial-com-clausula-de-vigencia-ausencia-de-assinatura-eletronica-qualificada-exigencia/)

## Armazenamento dos arquivos

PDFs ficam em `FILES_DIR` (padrão `./data/files`), por imobiliária, endereçados pelo SHA-256, com gravação atômica. **Não entram no backup lógico do banco**
(que guarda os metadados e os hashes): inclua `FILES_DIR` no backup do servidor ou troque a implementação de `FileStore` (`src/storage.ts`) por armazenamento de objetos (S3 ou equivalente).
Sem os arquivos, os hashes permitem detectar a falta, mas não recuperar o documento.

## Provedor de assinatura (decisão pendente)

Contrato previsto: criar envelope com o PDF aprovado e os signatários, acompanhar o status por webhook idempotente, baixar o PDF assinado e o relatório de assinaturas do provedor,
e registrar tudo na trilha do documento. A integração entra no lugar do passo manual "registrar assinatura e anexar PDF", mantendo as mesmas regras de conclusão.
Critérios para escolher: nível de assinatura oferecido (qualificada/ICP-Brasil se houver necessidade de registro), custo por documento, API e webhooks, retenção dos documentos,
e se o provedor é aceito pelo seu jurídico e pelos cartórios da sua região.
