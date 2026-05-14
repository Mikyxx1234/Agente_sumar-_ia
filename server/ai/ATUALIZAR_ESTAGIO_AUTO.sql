-- ╔════════════════════════════════════════════════════════════════════╗
-- ║   ATUALIZAR_ESTAGIO_AUTO — gerado por scripts/indexEstagioFromPdfs ║
-- ║   Revise antes de rodar no Supabase SQL Editor.                    ║
-- ║   Cada bloco UPDATE atualiza metadata.estagio do curso pelo id.    ║
-- ╚════════════════════════════════════════════════════════════════════╝

-- Gerado em 2026-05-14T19:12:25.391Z
-- Total cursos com estágio identificado: 46
-- Total cursos SEM estágio:               77
-- Cursos pulados (sem link/grau): 22
-- Falhas (download/openai):       0

-- ═════════════ CURSOS COM ESTÁGIO ═════════════

-- Administração Pública - EAD — TEM (2 disc., 80h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 80,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ADMINISTRAÇÃO PÚBLICA I (40h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ADMINISTRAÇÃO PÚBLICA II (40h)'
), true)
where id = 16710;

-- Agronomia - Semipresencial — TEM (2 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM AGRONOMIA I (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM AGRONOMIA II (80h)'
), true)
where id = 16711;

-- Arquitetura E Urbanismo - Semipresencial — TEM (1 disc., 120h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 120,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ARQUITETURA E URBANISMO (120h)'
), true)
where id = 16716;

-- Artes Visuais - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ARTE I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ARTE II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ARTE III (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ARTE IV (100h)'
), true)
where id = 16717;

-- Biomedicina - Semipresencial — TEM (2 disc., 640h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 640,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM BIOMEDICINA I (320h), ESTÁGIO CURRICULAR SUPERVISIONADO EM BIOMEDICINA II (320h)'
), true)
where id = 16719;

-- Ciências Biológicas - Semipresencial — TEM (2 disc., 360h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 360,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO PROFISSIONALIZANTE EM CIÊNCIAS BIOLÓGICAS I (180h), ESTÁGIO CURRICULAR SUPERVISIONADO PROFISSIONALIZANTE EM CIÊNCIAS BIOLÓGICAS II (180h)'
), true)
where id = 16726;

-- Ciências Biológicas - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS Finais DO ENSINO FUNDAMENTAL I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS Finais DO ENSINO FUNDAMENTAL II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM BIOLOGIA NO ENSINO MÉDIO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM BIOLOGIA NO ENSINO MÉDIO II (100h)'
), true)
where id = 16727;

-- Ciências Sociais - Semipresencial — TEM (7 disc., 380h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 7,
  'carga_total_horas', 380,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS I (20h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS II (30h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS III (30h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS IV (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS V (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS VI (70h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS SOCIAIS VII (70h)'
), true)
where id = 16733;

-- Educação Especial - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO ESPECIAL: ESPAÇOS FORMAIS I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO ESPECIAL: ESPAÇOS FORMAIS II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO ESPECIAL: ESPAÇOS NÃO-FORMAIS I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO ESPECIAL: ESPAÇOS NÃO-FORMAIS II (100h)'
), true)
where id = 16753;

-- Educação Física - Semipresencial — TEM (4 disc., 1280h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 1280,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO FÍSICA I (BACHAREL) (320h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO FÍSICA II (BACHAREL) (320h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO FÍSICA I (LICENCIATURA) (320h), ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO FÍSICA II (LICENCIATURA) (320h)'
), true)
where id = 16754;

-- Engenharia Ambiental - Semipresencial — TEM (2 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA AMBIENTAL I (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA AMBIENTAL II (80h)'
), true)
where id = 16757;

-- Engenharia Civil - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA CIVIL (160h)'
), true)
where id = 16758;

-- Engenharia De Computação - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA DE COMPUTAÇÃO (160h)'
), true)
where id = 16759;

-- Engenharia De Produção - Semipresencial — TEM (2 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA DE PRODUÇÃO I (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA DE PRODUÇÃO II (80h)'
), true)
where id = 16760;

-- Engenharia Elétrica - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA ELÉTRICA (160h)'
), true)
where id = 16762;

-- Engenharia Mecânica - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA MECÂNICA (160h)'
), true)
where id = 16763;

-- Engenharia Mecatrônica - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ENGENHARIA MECATRÔNICA (160h)'
), true)
where id = 16764;

-- Farmácia - Semipresencial — TEM (6 disc., 800h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 6,
  'carga_total_horas', 800,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁCIA I (20h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁCIA II (20h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁCIA III (40h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁCIA IV (240h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁNCIA V (240h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FARMÁCIA VI (240h)'
), true)
where id = 16767;

-- Filosofia - EAD — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA III (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA IV (100h)'
), true)
where id = 16768;

-- Filosofia - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA III (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FILOSOFIA IV (100h)'
), true)
where id = 16769;

-- Física - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS FINAIS DO ENSINO FUNDAMENTAL I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS FINAIS DO ENSINO FUNDAMENTAL II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FÍSICA NO ENSINO MÉDIO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FÍSICA NO ENSINO MÉDIO II (100h)'
), true)
where id = 16771;

-- Fisioterapia - Semipresencial — TEM (10 disc., 800h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 10,
  'carga_total_horas', 800,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA I (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA II (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA III (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA IV (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA V (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA VI (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA VII (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA VIII (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA IX (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM FISIOTERAPIA - ÁREA X (80h)'
), true)
where id = 16772;

-- Fonoaudiologia - Semipresencial — TEM (7 disc., 520h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 7,
  'carga_total_horas', 520,
  'detalhe', 'ESTÁGIO PRÁTICO EM DIAGNÓSTICO DOS DISTÚRBIOS DA COMUNICAÇÃO I (40h), ESTÁGIO PRÁTICO EM DISTÚRBIOS DA AUDIÇÃO I (40h), ESTÁGIO PRÁTICO EM DISTÚRBIOS DA COMUNICAÇÃO II (120h), ESTÁGIO PRÁTICO EM AUDIOLOGIA CLÍNICA I (120h), ESTÁGIO PRÁTICO EM AUDIOLOGIA CLÍNICA II (120h), ESTÁGIO PRÁTICO EM DIAGNÓSTICO DOS DISTÚRBIOS DA COMUNICAÇÃO II (40h), ESTÁGIO PRÁTICO EM DISTÚRBIOS DA AUDIÇÃO II (40h)'
), true)
where id = 16773;

-- Geografia - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM GEOGRAFIA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM GEOGRAFIA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM GEOGRAFIA NO ENSINO MÉDIO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM GEOGRAFIA NO ENSINO MÉDIO II (100h)'
), true)
where id = 16777;

-- Gerontologia - Semipresencial — TEM (2 disc., 668h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 668,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM GERONTOLOGIA I (334h), ESTÁGIO CURRICULAR SUPERVISIONADO EM GERONTOLOGIA II (334h)'
), true)
where id = 16778;

-- História - EAD — TEM (1 disc., 100h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 100,
  'detalhe', 'ESTÁGIO SUPERVISIONADO (100h)'
), true)
where id = 16799;

-- História - Semipresencial — TEM (7 disc., 330h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 7,
  'carga_total_horas', 330,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO DE HISTÓRIA I (20h), ESTÁGIO CURRICULAR SUPERVISIONADO EM HISTÓRIA II (30h), ESTÁGIO CURRICULAR SUPERVISIONADO EM HISTÓRIA III (30h), ESTÁGIO CURRICULAR SUPERVISONADO EM HISTÓRIA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL I (30h), ESTÁGIO CURRICULAR SUPERVISIONADO EM HISTÓRIA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL II (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM HISTÓRIA NO ENSINO MÉDIO I (70h), ESTÁGIO CURRICULAR SUPERVISIONADO EM HISTÓRIA NO ENSINO MÉDIO II (70h)'
), true)
where id = 16800;

-- Jornalismo - EAD — TEM (2 disc., 200h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 200,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM JORNALISMO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM JORNALISMO II (100h)'
), true)
where id = 16806;

-- Letras - Libras - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM LETRAS-LIBRAS NA EDUCAÇÃO INFANTIL (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LETRAS-LIBRAS NOS ANOS INICIAIS DO ENSINO FUNDAMENTAL (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LETRAS-LIBRAS NOS ANOS FINAIS DO ENSINO FUNDAMENTAL (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LETRAS-LIBRAS NO ENSINO MÉDIO (100h)'
), true)
where id = 16807;

-- Letras - Português E Espanhol - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA - FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA - INOVAÇÃO (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA ESPANHOLA - FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA ESPANHOLA - INOVAÇÃO (100h)'
), true)
where id = 16808;

-- Letras - Português E Inglês - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA: FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA - INOVAÇÃO (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA INGLESA: FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA INGLESA: INOVAÇÃO (100h)'
), true)
where id = 16809;

-- Letras - Português E Japonês - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA: FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA PORTUGUESA - INOVAÇÃO (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA JAPONESA: FUNDAMENTOS (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LÍNGUA JAPONESA: INOVAÇÃO (100h)'
), true)
where id = 16810;

-- Matemática - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM MATEMÁTICA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM MATEMÁTICA NOS ANOS FINAIS DO ENSINO FUNDAMENTAL II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM MATEMÁTICA NO ENSINO MÉDIO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM MATEMÁTICA NO ENSINO MÉDIO II (100h)'
), true)
where id = 16818;

-- Naturologia - Semipresencial — TEM (1 disc., 260h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 260,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM NATUROLOGIA (260h)'
), true)
where id = 16820;

-- Nutrição - Semipresencial — TEM (3 disc., 643h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 3,
  'carga_total_horas', 643,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM NUTRIÇÃO SOCIAL (214h), ESTÁGIO CURRICULAR SUPERVISIONADO EM UNIDADES DE ALIMENTAÇÃO E NUTRIÇÃO (215h), ESTÁGIO CURRICULAR SUPERVISIONADO EM NUTRIÇÃO CLÍNICA (214h)'
), true)
where id = 16821;

-- Óptica E Optometria - Semipresencial — TEM (8 disc., 520h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 8,
  'carga_total_horas', 520,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ÓPTICA (60h), ESTÁGIO CURRICULAR SUPERVISIONADO EM OPTOMETRIA I (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM AVALIAÇÃO PARA REABILITAÇÃO VISUAL (60h), ESTÁGIO CURRICULAR SUPERVISIONADO EM OPTOMETRIA II (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM REABILITAÇÃO VISUAL (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM OPTOMETRIA III (80h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LENTES RÍGIDAS (40h), ESTÁGIO CURRICULAR SUPERVISIONADO EM LENTES GELATINOSAS (40h)'
), true)
where id = 16822;

-- Pedagogia - Semipresencial — TEM (3 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 3,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM EDUCAÇÃO INFANTIL (150h), ESTÁGIO CURRICULAR SUPERVISIONADO NOS ANOS INICIAIS DO ENSINO FUNDAMENTAL (150h), ESTÁGIO CURRICULAR SUPERVISIONADO EM GESTÃO EDUCACIONAL (100h)'
), true)
where id = 16823;

-- Psicopedagogia - Semipresencial — TEM (3 disc., 300h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 3,
  'carga_total_horas', 300,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM PSICOPEDAGOGIA CLÍNICA (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM PSICOPEDAGOGIA INSTITUCIONAL (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM PSICOPEDAGOGIA EMPRESARIAL (100h)'
), true)
where id = 16832;

-- Química - Semipresencial — TEM (1 disc., 150h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 150,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM QUÍMICA (BACHARELADO) (150h)'
), true)
where id = 16834;

-- Química - Semipresencial — TEM (4 disc., 400h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 400,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS FINAIS DO ENSINO FUNDAM I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM CIÊNCIAS NOS ANOS FINAIS DO ENSINO FUNDAM II (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM QUÍMICA NO ENSINO MÉDIO I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM QUÍMICA NO ENSINO MÉDIO II (100h)'
), true)
where id = 16835;

-- Radiologia - Semipresencial — TEM (2 disc., 668h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 668,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM RADIOLOGIA I (334h), ESTÁGIO CURRICULAR SUPERVISIONADO EM RADIOLOGIA II (334h)'
), true)
where id = 16836;

-- Relações Públicas - EAD — TEM (2 disc., 200h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 2,
  'carga_total_horas', 200,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM RELAÇÕES PÚBLICAS I (100h), ESTÁGIO CURRICULAR SUPERVISIONADO EM RELAÇÕES PÚBLICAS II (100h)'
), true)
where id = 16840;

-- Serviço Social - Semipresencial — TEM (3 disc., 450h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 3,
  'carga_total_horas', 450,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM SERVIÇO SOCIAL I (150h), ESTÁGIO CURRICULAR SUPERVISIONADO EM SERVIÇO SOCIAL II (150h), ESTÁGIO CURRICULAR SUPERVISIONADO EM SERVIÇO SOCIAL III (150h)'
), true)
where id = 16846;

-- Teologia - EAD — TEM (4 disc., 200h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 4,
  'carga_total_horas', 200,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM TEOLOGIA I (50h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TEOLOGIA II (50h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TEOLOGIA III (50h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TEOLOGIA IV (50h)'
), true)
where id = 16851;

-- Terapia Ocupacional - Semipresencial — TEM (10 disc., 720h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 10,
  'carga_total_horas', 720,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA I (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA II (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA III (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA IV (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA V (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA VI (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA VII (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA VIII (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA IX (72h), ESTÁGIO CURRICULAR SUPERVISIONADO EM TERAPIA OCUPACIONAL ÁREA X (72h)'
), true)
where id = 16852;

-- Zootecnia - Semipresencial — TEM (1 disc., 160h)
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object(
  'tem', true,
  'quantidade', 1,
  'carga_total_horas', 160,
  'detalhe', 'ESTÁGIO CURRICULAR SUPERVISIONADO EM ZOOTECNIA (160h)'
), true)
where id = 16854;

-- ═════════════ CURSOS SEM ESTÁGIO ═════════════

-- Administração - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16708;

-- Análise De Dados De Alta Performance - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16712;

-- Análise E Desenvolvimento De Sistemas - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16714;

-- Banco De Dados - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16718;

-- Cibersegurança - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16720;

-- Ciência Da Computação - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16721;

-- Ciência De Dados - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16724;

-- Ciência Política - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16725;

-- Ciências Contábeis - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16729;

-- Ciências Econômicas - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16732;

-- Coaching E Mentoring - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16734;

-- Coding - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16735;

-- Comércio Exterior - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16736;

-- Computação Em Nuvem - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16738;

-- Criminologia - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16740;

-- Desenvolvimento Back-End - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16741;

-- Desenvolvimento Full Stack - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16742;

-- Desenvolvimento Mobile - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16743;

-- Design De Animação - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16744;

-- Design De Experiência - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16745;

-- Design De Interiores - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16746;

-- Design De Moda - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16747;

-- Design De Produto - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16749;

-- Design Gráfico - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16751;

-- Empreendedorismo - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16756;

-- Engenharia De Software - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16761;

-- Estética E Cosmética - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16765;

-- Eventos - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16766;

-- Física - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16770;

-- Fotografia - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16774;

-- Gastronomia - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16775;

-- Geografia - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16776;

-- Gestão Ambiental - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16779;

-- Gestão Comercial - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16781;

-- Gestão Da Produção Industrial - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16782;

-- Gestão Da Qualidade - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16783;

-- Gestão Da Saúde Pública - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16784;

-- Gestão Das Organizações Do Terceiro Setor - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16786;

-- Gestão De Cooperativas - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16787;

-- Gestão De Recursos Humanos - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16790;

-- Gestão De Segurança Privada - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16792;

-- Gestão De Turismo - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16793;

-- Gestão Desportiva E De Lazer - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16794;

-- Gestão Do Agronegócio - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16795;

-- Gestão Financeira - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16796;

-- Gestão Hospitalar - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16797;

-- Gestão Pública - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16798;

-- Influenciador Digital - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16801;

-- Inteligência Artificial - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16802;

-- Interdisciplinar Em Humanidades - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16803;

-- Internet Das Coisas - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16804;

-- Jogos Digitais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16805;

-- Logística - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16812;

-- Marketing - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16814;

-- Marketing Digital - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16816;

-- Matemática - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16817;

-- Consiliação, Mediação E Arbitragem - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16819;

-- Perícia Judicial E Extrajudicial - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16824;

-- Podologia - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16825;

-- Processos Gerenciais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16826;

-- Produção Audiovisual - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16827;

-- Produção Cultural - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16828;

-- Produção Midiática - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16829;

-- Estudos Teóricos Psicanalíticos e Sociais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16831;

-- Publicidade E Propaganda - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16833;

-- Redes De Computadores - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16837;

-- Relações Internacionais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16839;

-- Secretariado - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16841;

-- Segurança Da Informação - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16842;

-- Segurança No Trabalho - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16843;

-- Segurança No Trânsito - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16844;

-- Segurança Pública - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16845;

-- Serviços Jurídicos E Notariais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16847;

-- Serviços Penais - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16848;

-- Sistemas De Informação - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16849;

-- Sistemas Para Internet - EAD — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16850;

-- Terapias Integrativas E Complementares - Semipresencial — SEM estágio
update public.documents
set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{estagio}', jsonb_build_object('tem', false), true)
where id = 16853;
