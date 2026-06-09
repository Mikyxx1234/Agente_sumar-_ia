import {
  Stack, Row, Grid, H1, H2, H3, Text, Divider, Spacer,
  Card, CardHeader, CardBody, Pill, Callout, Link,
  useHostTheme,
} from "cursor/canvas";

const CURSO = {
  nome: "Pedagogia",
  modalidade: "Semipresencial",
  titulacao: "Licenciatura",
  duracao: "8 semestres",
  investimento: "R$ 117,00/mês",
  codigo: "PED_SEMI",
  url: "https://sumare.edu.br/graduacao/semi/pedagogia",
};

const DISCIPLINAS = [
  "Bem-Vindo ao AVA Sumaré",
  "Conheça seu Tutor",
  "Conheça seu curso - Pedagogia Semipresencial",
  "Atividade Extensionista - Educação e Docência",
  "História da Educação",
  "Educação Infantil",
  "Saberes e Fazeres da Educação Infantil",
  "Biblioteca Virtual",
  "PAAS - Língua Portuguesa",
  "PAAS - Matemática",
  "PAAS - Informática Básica",
  "Atividade Extensionista - Educação e Transformação",
  "Didática",
  "A Pedagogia e seus Contextos Cotidianos",
  "Teoria e Prática do Ensino",
  "Atividade Extensionista - Educação e Diversidade",
  "Língua Brasileira de Sinais - LIBRAS",
  "Educação e Ludicidade",
  "Laboratórios, Bibliotecas e Ambientes de Convivência na Escola",
  "Educação em Direitos Humanos e Educação Ambiental",
  "Psicologia da Educação e do Desenvolvimento",
  "Atividade Extensionista - Educação e Formação",
  "Sociologia da Educação",
  "Educação de Jovens e Adultos - EJA",
  "Ensino Fundamental de 9 Anos",
  "Estágio Obrigatório",
  "Metodologia da Língua Portuguesa",
  "Metodologia do Ensino da Matemática",
  "Avaliação da Aprendizagem",
  "Metodologia de Alfabetização",
  "Projeto de Pesquisa Integrador em Pedagogia",
  "Currículos e Políticas Educacionais para a Educação Básica",
  "Psicomotricidade e Movimento",
  "Psicologia do Desenvolvimento da Infância",
  "Desenvolvimento e Aprendizagem Motora",
  "Organização da Educação Básica e o Currículo",
  "Educação Inclusiva, Ética e Direitos Humanos",
  "Pedagogia em Espaços não Escolares",
  "Literatura Infanto Juvenil",
  "Fundamentos da Interdisciplinaridade",
  "Sociedade, Cultura e Cidadania",
  "Metodologia do Ensino de Ciências da Natureza e Sustentabilidade",
  "Metodologia do Ensino de História e Geografia",
];

const INTRO =
  "As disciplinas de cada curso da Sumaré são concebidas pelo NDE (Núcleo Docente Estruturante), composto por professores com notório saber, que além da DCN (Diretrizes Curriculares Nacionais) de cada curso, levam em consideração as pautas mais importantes do mercado de trabalho.";

function WhatsAppBubble({ outbound, children }: { outbound?: boolean; children: React.ReactNode }) {
  const t = useHostTheme();
  return (
    <div
      style={{
        alignSelf: outbound ? "flex-end" : "flex-start",
        maxWidth: "88%",
        padding: "10px 14px",
        borderRadius: outbound ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
        background: outbound ? t.accent.control : t.fill.secondary,
        color: outbound ? t.text.onAccent : t.text.primary,
      }}
    >
      <Text as="span" size="small" tone={outbound ? undefined : "primary"}>
        {children}
      </Text>
    </div>
  );
}

function PdfPage() {
  const t = useHostTheme();
  const metade = Math.ceil(DISCIPLINAS.length / 2);

  return (
    <div
      style={{
        background: t.bg.elevated,
        border: `1px solid ${t.stroke.secondary}`,
        borderRadius: 4,
        padding: 32,
        maxWidth: 680,
      }}
    >
      <Stack gap={20}>
        <Row justify="space-between" align="start">
          <Stack gap={4}>
            <Text weight="bold" size="small" tone="secondary">
              SUMARÉ CENTRO UNIVERSITÁRIO
            </Text>
            <H2>Grade curricular</H2>
            <H3>{CURSO.nome}</H3>
          </Stack>
          <Stack gap={4} style={{ textAlign: "right" }}>
            <Pill tone="info">{CURSO.modalidade}</Pill>
            <Text tone="tertiary" size="small">{CURSO.titulacao}</Text>
          </Stack>
        </Row>

        <Grid columns={3} gap={12}>
          <Stack gap={2}>
            <Text tone="tertiary" size="small">Duração</Text>
            <Text weight="semibold" size="small">{CURSO.duracao}</Text>
          </Stack>
          <Stack gap={2}>
            <Text tone="tertiary" size="small">Investimento</Text>
            <Text weight="semibold" size="small">{CURSO.investimento}</Text>
          </Stack>
          <Stack gap={2}>
            <Text tone="tertiary" size="small">Disciplinas</Text>
            <Text weight="semibold" size="small">{DISCIPLINAS.length} componentes</Text>
          </Stack>
        </Grid>

        <Divider />

        <Stack gap={8}>
          <Text weight="semibold">O que você vai aprender</Text>
          <Text tone="secondary" size="small">{INTRO}</Text>
        </Stack>

        <Grid columns={2} gap={8}>
          <Stack gap={4}>
            {DISCIPLINAS.slice(0, metade).map((d, i) => (
              <Text key={d} size="small">
                {String(i + 1).padStart(2, "0")}. {d}
              </Text>
            ))}
          </Stack>
          <Stack gap={4}>
            {DISCIPLINAS.slice(metade).map((d, i) => (
              <Text key={d} size="small">
                {String(metade + i + 1).padStart(2, "0")}. {d}
              </Text>
            ))}
          </Stack>
        </Grid>

        <Divider />

        <Stack gap={4}>
          <Text tone="tertiary" size="small">
            Fonte oficial: sumare.edu.br · Código do curso: {CURSO.codigo}
          </Text>
          <Text tone="quaternary" size="small">
            Documento informativo. A matriz curricular pode ser atualizada conforme normas do MEC e deliberações internas.
          </Text>
        </Stack>
      </Stack>
    </div>
  );
}

export default function PedagogiaGradeCandidato() {
  return (
    <Stack gap={24} style={{ padding: 20, maxWidth: 900 }}>
      <Stack gap={6}>
        <H1>Como o candidato recebe a grade — Pedagogia</H1>
        <Text tone="secondary">
          Simulação do fluxo: candidato solicita a grade no WhatsApp → agente responde com resumo + PDF anexo.
          Dados extraídos do site oficial (modalidade Semipresencial).
        </Text>
      </Stack>

      <Card>
        <CardHeader>1. Conversa no WhatsApp</CardHeader>
        <CardBody>
          <Stack gap={10} style={{ maxWidth: 420 }}>
            <WhatsAppBubble>
              Oi! Quero saber quais matérias tem no curso de Pedagogia semipresencial de vocês?
            </WhatsAppBubble>
            <WhatsAppBubble outbound>
              Olá! Pedagogia Semipresencial é Licenciatura, 8 semestres, com investimento a partir de R$ 117/mês.
              {"\n\n"}
              O curso forma professores para Educação Infantil e Anos Iniciais. São 43 disciplinas no total — incluindo Didática, Educação Infantil, História da Educação, LIBRAS, Estágio Obrigatório e metodologias de ensino.
              {"\n\n"}
              Segue em anexo a grade curricular completa em PDF para você consultar com calma. Quer que eu te explique alguma disciplina ou já posso te orientar na inscrição?
            </WhatsAppBubble>
            <Row gap={8} align="center" style={{ alignSelf: "flex-end" }}>
              <Pill tone="neutral">grade-pedagogia-semi.pdf</Pill>
            </Row>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader trailing={<Text tone="tertiary" size="small">Prévia do anexo PDF</Text>}>
          2. Documento enviado ao candidato
        </CardHeader>
        <CardBody>
          <PdfPage />
        </CardBody>
      </Card>

      <Callout tone="info">
        No futuro, o agente poderá gerar esse PDF automaticamente a partir do banco de dados (grade já extraída do site)
        e enviar pelo WhatsApp quando o candidato pedir matriz curricular, ementa ou &quot;o que vou estudar&quot;.
      </Callout>

      <Text tone="quaternary" size="small">
        Referência: <Link href={CURSO.url}>{CURSO.url}</Link>
      </Text>
    </Stack>
  );
}
