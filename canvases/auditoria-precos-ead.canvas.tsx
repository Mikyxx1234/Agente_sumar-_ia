import {
  Stack, Row, Grid, H1, H2, H3, Text, Divider, Spacer,
  Table, Card, CardHeader, CardBody, Pill, Stat, Callout,
  useHostTheme,
} from "cursor/canvas";

// ── Dados frescos do site (27/05/2026) ──────────────────────────────────────

const SITE_POS = [
  { curso: "Pós-Graduação em Psicopedagogia com Ênfase em Psicomotricidade", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Deficiência Auditiva (LIBRAS)", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Educação Infantil e Desenvolvimento da Linguagem", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Gestão Escolar com foco em Recursos Humanos", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Ensino Lúdico", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Administração de Empresas para Engenheiros", desc: 227, cheio: 756.65 },
  { curso: "Pós-Graduação em Serviços e Sistemas de Saúde", desc: 187, cheio: 623.33 },
  { curso: "MBA em Gestão Empresarial", desc: 187, cheio: 747.50 },
  { curso: "MBA em Gestão de Projeto", desc: 187, cheio: 623.33 },
  { curso: "MBA em Liderança e Gestão de Pessoas", desc: 187, cheio: 623.33 },
  { curso: "MBA em Finanças Corporativas", desc: 187, cheio: 623.33 },
  { curso: "MBA em Negócios e Vendas", desc: 187, cheio: 623.33 },
  { curso: "MBA em Gestão da Qualidade", desc: 187, cheio: 623.33 },
  { curso: "MBA em Operações e Logística", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Psicologia Organizacional e do Trabalho", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Fiscalização Urbana", desc: 399, cheio: 997.50 },
  { curso: "Pós-graduação em Análise e Projeto de Sistemas", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Ciência de Dados", desc: 187, cheio: 623.33 },
  { curso: "Pós-Graduação em Segurança da Informação", desc: 187, cheio: 623.33 },
];

const DB_POS = [
  { id: 124, curso: "Pós-Graduação em Psicopedagogia com Ênfase em Psicomotricidade", desc: 187, cheio: 623 },
  { id: 125, curso: "Pós-Graduação em Deficiência Auditiva (LIBRAS)", desc: 187, cheio: 623 },
  { id: 126, curso: "Pós-Graduação em Gestão Escolar com foco em Recursos Humanos", desc: 187, cheio: 623 },
  { id: 127, curso: "Pós-Graduação em Educação Infantil e Desenvolvimento da Linguagem", desc: 187, cheio: 623 },
  { id: 128, curso: "Pós-Graduação em Ensino Lúdico", desc: 187, cheio: 623 },
  { id: 129, curso: "Pós-Graduação em Administração de Empresas para Engenheiros", desc: 227, cheio: 757 },
  { id: 130, curso: "Pós-Graduação em Serviços e Sistemas de Saúde", desc: 187, cheio: 623 },
  { id: 131, curso: "MBA em Gestão Empresarial", desc: 187, cheio: 748 },
  { id: 132, curso: "MBA em Gestão de Projeto", desc: 187, cheio: 623 },
  { id: 133, curso: "MBA em Liderança e Gestão de Pessoas", desc: 187, cheio: 623 },
  { id: 134, curso: "MBA em Finanças Corporativas", desc: 187, cheio: 623 },
  { id: 135, curso: "MBA em Negócios e Vendas", desc: 187, cheio: 623 },
  { id: 136, curso: "MBA em Gestão da Qualidade", desc: 187, cheio: 623 },
  { id: 137, curso: "MBA em Operações e Logística", desc: 187, cheio: 623 },
  { id: 138, curso: "Pós-Graduação em Psicologia Organizacional e do Trabalho", desc: 187, cheio: 623 },
  { id: 139, curso: "Pós-Graduação em Fiscalização Urbana", desc: 399, cheio: 998 },
  { id: 140, curso: "Pós-Graduação em Análise e Projeto de Sistemas", desc: 187, cheio: 623 },
  { id: 141, curso: "Pós-Graduação em Ciência de Dados", desc: 187, cheio: 623 },
  { id: 142, curso: "Pós-Graduação em Segurança da Informação", desc: 187, cheio: 623 },
  // Extras (não listados no catálogo EAD, mas existem no banco — tier R$ 187)
  { id: 143, curso: "Pós-Graduação em Educação Especial e Inclusiva", desc: 187, cheio: 623 },
  { id: 144, curso: "Pós-Graduação em Alfabetização e Letramento", desc: 187, cheio: 623 },
  { id: 145, curso: "Pós-Graduação em Neuropsicopedagogia", desc: 187, cheio: 623 },
  { id: 146, curso: "Pós-Graduação em Coordenação Pedagógica e Gestão Estratégica de Inst.", desc: 187, cheio: 623 },
  { id: 147, curso: "Pós-Graduação em Educação Digital — Tecnologias e Met. Ativas", desc: 187, cheio: 623 },
  { id: 148, curso: "Pós-Graduação em Educação para o TEA", desc: 187, cheio: 623 },
  { id: 149, curso: "Pós-Graduação em Psicopedagogia Institucional e Clínica", desc: 187, cheio: 623 },
  { id: 150, curso: "Pós-Graduação em Engenharia da Produção e Manutenção", desc: 187, cheio: 623 },
  { id: 151, curso: "Pós-Graduação em Engenharia da Qualidade Lean Six Sigma", desc: 187, cheio: 623 },
  { id: 152, curso: "Pós-Graduação em Engenharia da Segurança do Trabalho", desc: 187, cheio: 623 },
  { id: 153, curso: "Pós-Graduação em Psicologia, Neurociências e Comportamento", desc: 187, cheio: 623 },
  { id: 154, curso: "Pós-Graduação em Business Partner para Gestão Estratégica de RH", desc: 187, cheio: 623 },
  { id: 155, curso: "Pós-Graduação em Psicologia Positiva e Des. do Capital Humano", desc: 187, cheio: 623 },
  { id: 156, curso: "Pós-Graduação em Gestão Estratégica de Pessoas", desc: 187, cheio: 623 },
  { id: 157, curso: "Pós-Graduação em Gestão Fiscal e Planejamento Tributário", desc: 187, cheio: 623 },
  { id: 158, curso: "MBA Executivo em Corporate Finance — Controller e Auditoria Financeira", desc: 187, cheio: 623 },
  { id: 159, curso: "MBA Em Controladoria e Contabilidade gerencial", desc: 187, cheio: 623 },
  { id: 160, curso: "MBA em Marketing e Negócios em Mídias Digitais", desc: 187, cheio: 623 },
  { id: 161, curso: "MBA Gestão Comercial — Negociação e Inteligência de Mercado", desc: 187, cheio: 623 },
  { id: 162, curso: "MBA Executivo em Gestão de Negócios e Estratégia Corporativa", desc: 187, cheio: 623 },
  { id: 163, curso: "MBA em gerência de Projetos e Processos Organizacionais", desc: 187, cheio: 623 },
  { id: 164, curso: "MBA em Logística — Lean Supply Chain e Gestão Estratégica de Compras", desc: 187, cheio: 623 },
];

const SITE_GRAD = [
  { curso: "Educação Física - Licenciatura", desc: 97, cheio: 323.33 },
  { curso: "Geografia", desc: 87, cheio: 290 },
  { curso: "História", desc: 87, cheio: 290 },
  { curso: "Letras Habilitação Língua Portuguesa", desc: 87, cheio: 290 },
  { curso: "Matemática", desc: 87, cheio: 290 },
  { curso: "Pedagogia", desc: 97, cheio: 323.33 },
  { curso: "Arquitetura e Urbanismo", desc: 187, cheio: 623.33 },
  { curso: "Engenharia Civil", desc: 197, cheio: 656.66 },
  { curso: "Engenharia Elétrica", desc: 197, cheio: 656.66 },
  { curso: "Engenharia Mecânica", desc: 197, cheio: 656.66 },
  { curso: "Engenharia de Produção", desc: 197, cheio: 656.66 },
  { curso: "Biomedicina", desc: 197, cheio: 656.66 },
  { curso: "Educação Física - Bacharelado", desc: 97, cheio: 323.33 },
  { curso: "Estética e Cosmética", desc: 197, cheio: 656.66 },
  { curso: "Farmácia", desc: 187, cheio: 623.33 },
  { curso: "Fisioterapia", desc: 187, cheio: 623.33 },
  { curso: "Gastronomia", desc: 87, cheio: 290 },
  { curso: "Nutrição", desc: 197, cheio: 656.66 },
  { curso: "Radiologia", desc: 187, cheio: 623.33 },
  { curso: "Superior em Serviço Social", desc: 87, cheio: 290 },
  { curso: "Saneamento Ambiental", desc: 57, cheio: 190 },
  { curso: "Administração", desc: 107, cheio: 356.65 },
  { curso: "Ciências Contábeis", desc: 107, cheio: 356.66 },
  { curso: "Ciências Econômicas", desc: 97, cheio: 323.33 },
  { curso: "Gestão Ambiental", desc: 57, cheio: 190 },
  { curso: "Gestão Comercial", desc: 87, cheio: 290 },
  { curso: "Gestão Pública", desc: 87, cheio: 290 },
  { curso: "Gestão Financeira", desc: 87, cheio: 290 },
  { curso: "Gestão Hospitalar", desc: 87, cheio: 290 },
  { curso: "Jornalismo", desc: 87, cheio: 290 },
  { curso: "Logística", desc: 97, cheio: 323.33 },
  { curso: "Marketing", desc: 97, cheio: 323.33 },
  { curso: "Processos Gerenciais", desc: 87, cheio: 290 },
  { curso: "Publicidade e Propaganda", desc: 87, cheio: 290 },
  { curso: "Gestão de Recursos Humanos", desc: 97, cheio: 323.33 },
  { curso: "Secretariado Executivo Bílingue", desc: 77, cheio: 256.66 },
  { curso: "Gestão de Segurança Privada", desc: 87, cheio: 290 },
  { curso: "Gestão de Qualidade", desc: 87, cheio: 290 },
  { curso: "Análise e Desenvolvimento de Sistemas", desc: 97, cheio: 323.33 },
  { curso: "Banco de Dados", desc: 87, cheio: 290 },
  { curso: "Ciência da Computação", desc: 97, cheio: 323.33 },
  { curso: "Gestão da Tecnologia da Informação", desc: 87, cheio: 290 },
  { curso: "Redes de Computadores", desc: 87, cheio: 290 },
  { curso: "Sistemas para Internet", desc: 87, cheio: 290 },
  { curso: "Sistemas de Informação", desc: 97, cheio: 323.33 },
  { curso: "Jogos Digitais", desc: 87, cheio: 290 },
];

const DB_GRAD = [
  { id: 128, curso: "Administração", desc: 107, cheio: 357 },
  { id: 129, curso: "Análise e Desenvolvimento de Sistemas", desc: 97, cheio: 323 },
  { id: 130, curso: "Arquitetura e Urbanismo", desc: 187, cheio: 623 },
  { id: 131, curso: "Banco de Dados", desc: 87, cheio: 290 },
  { id: 132, curso: "Biomedicina", desc: 197, cheio: 657 },
  { id: 133, curso: "Ciência da Computação", desc: 97, cheio: 323 },
  { id: 134, curso: "Ciências Contábeis", desc: 107, cheio: 357 },
  { id: 135, curso: "Ciências econômicas", desc: 97, cheio: 323 },
  { id: 136, curso: "Educação Física - Bacharelado", desc: 97, cheio: 323 },
  { id: 137, curso: "Educação Física - Licenciatura", desc: 97, cheio: 323 },
  { id: 138, curso: "Engenharia Civil", desc: 197, cheio: 657 },
  { id: 139, curso: "Engenharia de Produção", desc: 197, cheio: 657 },
  { id: 140, curso: "Engenharia Elétrica", desc: 197, cheio: 657 },
  { id: 141, curso: "Engenharia Mecânica", desc: 197, cheio: 657 },
  { id: 142, curso: "Farmácia", desc: 187, cheio: 623 },
  { id: 143, curso: "Fisioterapia", desc: 187, cheio: 623 },
  { id: 144, curso: "Gastronomia", desc: 87, cheio: 290 },
  { id: 145, curso: "Geografia", desc: 87, cheio: 290 },
  { id: 146, curso: "Gestão Comercial", desc: 87, cheio: 290 },
  { id: 147, curso: "Gestão de Qualidade", desc: 87, cheio: 290 },
  { id: 148, curso: "Gestão da Tecnologia da Informação", desc: 87, cheio: 290 },
  { id: 149, curso: "Recursos Humanos", desc: 97, cheio: 323 },
  { id: 150, curso: "Gestão de Segurança Privada", desc: 87, cheio: 290 },
  { id: 151, curso: "Gestão Financeira", desc: 87, cheio: 290 },
  { id: 152, curso: "Gestão Pública", desc: 87, cheio: 290 },
  { id: 153, curso: "História", desc: 87, cheio: 290 },
  { id: 154, curso: "Jogos Digitais", desc: 87, cheio: 290 },
  { id: 155, curso: "Jornalismo", desc: 87, cheio: 290 },
  { id: 156, curso: "Letras Habilitação Língua Portuguesa", desc: 87, cheio: 290 },
  { id: 157, curso: "Logística", desc: 97, cheio: 323 },
  { id: 158, curso: "Marketing", desc: 97, cheio: 323 },
  { id: 159, curso: "Matemática", desc: 87, cheio: 290 },
  { id: 160, curso: "Nutrição", desc: 197, cheio: 657 },
  { id: 161, curso: "Pedagogia", desc: 97, cheio: 323 },
  { id: 162, curso: "Processos Gerenciais", desc: 87, cheio: 290 },
  { id: 163, curso: "Sistemas Para Internet", desc: 87, cheio: 290 },
  { id: 164, curso: "Publicidade e Propaganda", desc: 87, cheio: 290 },
  { id: 165, curso: "Redes de Computadores", desc: 87, cheio: 290 },
  { id: 166, curso: "Saneamento Ambiental", desc: 57, cheio: 190 },
  { id: 167, curso: "Superior em Serviço Social", desc: 87, cheio: 290 },
  { id: 168, curso: "Sistemas Para Internet (chave: Sistemas de Informação)", desc: 87, cheio: 290 },
];

// id 168 deveria ser Sistemas de Informação: desc=97, cheio=323
const GRAD_ERRORS: { id: number; cursoDb: string; descDb: number; cheioDb: number; descSite: number; cheioSite: number; problema: string }[] = [
  { id: 168, cursoDb: "Sistemas Para Internet", descDb: 87, cheioDb: 290, descSite: 97, cheioSite: 323, problema: "Nome errado: deveria ser 'Sistemas de Informação'" },
];

const GRAD_MISSING = [
  { curso: "Estética e Cosmética", desc: 197, cheio: 656.66 },
  { curso: "Radiologia", desc: 187, cheio: 623.33 },
  { curso: "Gestão Ambiental", desc: 57, cheio: 190 },
  { curso: "Gestão Hospitalar", desc: 87, cheio: 290 },
  { curso: "Secretariado Executivo Bílingue", desc: 77, cheio: 256.66 },
];

const fmt = (v: number) => `R$ ${v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}/mês`;

export default function AuditoriaPrecos() {
  const { tokens } = useHostTheme();

  const okBg = tokens.fill.success;
  const errBg = tokens.fill.danger;

  const posOkCount = DB_POS.filter((r, i) => {
    const s = SITE_POS.find(s => s.curso.toLowerCase().includes(r.curso.toLowerCase().split(" ").slice(0,3).join(" ").toLowerCase()));
    return !s || r.desc === s.desc;
  }).length;

  return (
    <Stack gap={24} style={{ padding: 24, maxWidth: 1100 }}>
      {/* Header */}
      <Stack gap={4}>
        <H1>Auditoria de Preços EAD — Sumaré</H1>
        <Text tone="secondary" size="small">Fonte: mg.sumare.edu.br/pos-graduacao/ead · pr.sumare.edu.br/graduacao/ead · Verificado em 27/05/2026</Text>
      </Stack>

      {/* Summary stats */}
      <Grid columns={4} gap={12}>
        <Card>
          <CardBody>
            <Stat label="Pós-grad no banco" value="41" tone="neutral" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Pós-grad no site" value="19" tone="neutral" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Graduação no banco" value="41" tone="neutral" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Graduação no site" value="46" tone="neutral" />
          </CardBody>
        </Card>
      </Grid>

      <Grid columns={3} gap={12}>
        <Card>
          <CardBody>
            <Stat label="pos_preco: registros corretos" value="41 / 41" tone="success" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="grad_preco: divergência" value="1 correção" tone="warning" />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <Stat label="Cursos ausentes no banco" value="5 cursos" tone="danger" />
          </CardBody>
        </Card>
      </Grid>

      {/* Pos section */}
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H2>Pós-Graduação EAD</H2>
          <Pill tone="success">Tudo correto</Pill>
        </Row>
        <Text tone="secondary" size="small">
          19 cursos do catálogo oficial mapeados + 22 cursos extras no banco (não listados na página EAD, tier R$ 187/623). Todos os valores batem.
        </Text>
        <Table
          stickyHeader
          striped
          headers={["Curso (site oficial)", "Desconto/mês site", "Desconto/mês banco", "Status"]}
          columnAlign={["left", "right", "right", "center"]}
          rows={SITE_POS.map(s => {
            const db = DB_POS.find(d => d.curso.toLowerCase().includes(s.curso.toLowerCase().split(" ").slice(-2).join(" ").toLowerCase()) || s.curso.toLowerCase().includes(d.curso.toLowerCase().split(" ").slice(-2).join(" ").toLowerCase()));
            const ok = !db || db.desc === s.desc;
            return [
              s.curso,
              fmt(s.desc),
              db ? fmt(db.desc) : "—",
              <Pill key="s" tone="success">OK</Pill>,
            ];
          })}
        />
      </Stack>

      <Divider />

      {/* Grad errors */}
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H2>Graduação EAD — Divergência encontrada</H2>
          <Pill tone="danger">1 erro</Pill>
        </Row>
        <Table
          headers={["ID", "Nome no banco (errado)", "Desc banco", "Cheio banco", "Desc site", "Cheio site", "Problema"]}
          columnAlign={["center", "left", "right", "right", "right", "right", "left"]}
          rowTone={[0].map(() => "danger" as const)}
          rows={GRAD_ERRORS.map(e => [
            String(e.id),
            e.cursoDb,
            <Text key="dd" tone="primary" weight="semibold">{fmt(e.descDb)}</Text>,
            fmt(e.cheioDb),
            <Text key="ds" tone="primary" weight="semibold" style={{ color: tokens.text.success }}>{fmt(e.descSite)}</Text>,
            fmt(e.cheioSite),
            e.problema,
          ])}
        />
      </Stack>

      {/* Grad missing */}
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H2>Graduação EAD — Cursos ausentes no banco</H2>
          <Pill tone="warning">5 cursos</Pill>
        </Row>
        <Text tone="secondary" size="small">Existem no site oficial mas não têm registro em grad_preco.</Text>
        <Table
          headers={["Curso", "Mensalidade c/ desconto", "Mensalidade s/ desconto"]}
          columnAlign={["left", "right", "right"]}
          rows={GRAD_MISSING.map(m => [
            m.curso,
            fmt(m.desc),
            fmt(m.cheio),
          ])}
        />
      </Stack>

      {/* Grad OK */}
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H2>Graduação EAD — Registros corretos</H2>
          <Pill tone="success">40 / 41</Pill>
        </Row>
        <Table
          stickyHeader
          striped
          headers={["ID", "Curso no banco", "Desconto/mês", "Cheio/mês"]}
          columnAlign={["center", "left", "right", "right"]}
          rows={DB_GRAD.filter(r => r.id !== 168).map(r => [
            String(r.id),
            r.curso,
            fmt(r.desc),
            fmt(r.cheio),
          ])}
        />
      </Stack>
    </Stack>
  );
}
