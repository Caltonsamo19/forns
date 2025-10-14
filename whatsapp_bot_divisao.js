const axios = require('axios');

class WhatsAppBotDivisao {
    constructor() {
        this.comprovantesMemorizados = {};
        this.processandoDivisoes = new Set();
        
        // OTIMIZAÇÃO: Sistema de fila para controle de requisições
        this.filaRequisicoes = [];
        this.processandoFila = false;
        this.limiteConcorrencia = 5; // Máx 5 requisições simultâneas
        this.intervaloEntreRequisicoes = 200; // 200ms entre requisições
        this.estatisticasRede = {
            sucessos: 0,
            falhas: 0,
            tempoMedioResposta: 1000,
            ultimaFalha: null
        };
        
        // Inicializar IA usando variável de ambiente (mesma do servidor)
        const WhatsAppAIAtacado = require('./whatsapp_ai_atacado');
        const openaiApiKey = process.env.OPENAI_API_KEY;
        if (openaiApiKey) {
            this.ia = new WhatsAppAIAtacado(openaiApiKey);
            console.log('🧠 IA integrada ao bot de divisão usando .env!');
        } else {
            this.ia = null;
            console.log('⚠️ IA não disponível - OPENAI_API_KEY não encontrada no .env');
        }
        
        // URLs dos Google Apps Scripts existentes
        this.SCRIPTS_CONFIG = {
            PEDIDOS: 'https://script.google.com/macros/s/AKfycbzdvM-IrH4a6gS53WZ0J-AGXY0duHfgv15DyxdqUm1BLEm3Z15T67qgstu6yPTedgOSCA/exec',
            PAGAMENTOS: 'https://script.google.com/macros/s/AKfycbzzifHGu1JXc2etzG3vqK5Jd3ihtULKezUTQQIDJNsr6tXx3CmVmKkOlsld0x1Feo0H/exec'
        };
        
        // Configuração dos grupos (mesma estrutura do sistema atual)
        this.CONFIGURACAO_GRUPOS = {
            '120363419652375064@g.us': {
                nome: 'Net Fornecedor V',
                precos: {
                    10240: 125,    // 10GB = 125MT
                    20480: 250,    // 20GB = 250MT
                    30720: 375,    // 30GB = 375MT
                    40960: 500,    // 40GB = 500MT
                    51200: 625,    // 50GB = 625MT
                    61440: 750,    // 60GB = 750MT
                    71680: 875,    // 70GB = 875MT
                    81920: 1000,   // 80GB = 1000MT
                    92160: 1125,   // 90GB = 1125MT
                    102400: 1250   // 100GB = 1250MT
                },
                // NÚMEROS DE PAGAMENTO DO GRUPO (NUNCA devem receber megas)
                numerosPagamento: [
                    '870059057',   // Número eMola do grupo
                    '840326152',   // Número M-Pesa do VASCO (sem prefixo)
                    '258840326152', // Versão completa com prefixo
                    '877777777'    // Adicionar outros números de pagamento do grupo aqui
                ]
            }
            // Adicionar outros grupos conforme necessário
        };
        
        // Limpar comprovativos antigos a cada 10 minutos
        setInterval(() => {
            this.limparComprovantesAntigos();
        }, 10 * 60 * 1000);
        
        // OTIMIZAÇÃO: Sistema de recuperação automática
        setInterval(() => {
            this.verificarSaudeDoSistema();
        }, 5 * 60 * 1000); // A cada 5 minutos
        
        console.log('🔄 Bot de Divisão inicializado - Sistema otimizado com fila inteligente!');
    }
    
    // === FUNÇÃO PARA NORMALIZAR VALORES INTERNO ===
    normalizarValorInterno(valor) {
        if (typeof valor === 'number') {
            return valor;
        }
        
        if (typeof valor === 'string') {
            let valorLimpo = valor.trim();
            
            // Casos especiais: valores com múltiplos zeros após vírgula (ex: "1,0000" = 1000MT)
            // Padrão: número seguido de vírgula e só zeros
            const regexZerosAposVirgula = /^(\d+),0+$/;
            const matchZeros = valorLimpo.match(regexZerosAposVirgula);
            if (matchZeros) {
                // "1,0000" significa 1000 meticais (vírgula + zeros = multiplicador de milhares)
                const baseNumero = parseInt(matchZeros[1]);
                const numeroZeros = valorLimpo.split(',')[1].length;
                // Para "1,0000": base=1, zeros=4, então 1 * 1000 = 1000
                const multiplicador = numeroZeros >= 3 ? 1000 : Math.pow(10, numeroZeros);
                return baseNumero * multiplicador;
            }
            
            // Detectar se vírgula é separador de milhares ou decimal
            const temVirgulaSeguida3Digitos = /,\d{3}($|\D)/.test(valorLimpo);
            
            if (temVirgulaSeguida3Digitos) {
                // Vírgula como separador de milhares: "1,000" ou "10,500.50"
                valorLimpo = valorLimpo.replace(/,(?=\d{3}($|\D))/g, '');
            } else {
                // Vírgula como separador decimal: "1,50" → "1.50"
                valorLimpo = valorLimpo.replace(',', '.');
            }
            
            const valorNumerico = parseFloat(valorLimpo);
            
            if (isNaN(valorNumerico)) {
                console.warn(`⚠️ DIVISÃO: Valor não pôde ser normalizado: "${valor}"`);
                return valor;
            }
            
            // Retorna inteiro se não tem decimais significativos
            return (Math.abs(valorNumerico % 1) < 0.0001) ? Math.round(valorNumerico) : valorNumerico;
        }
        
        return valor;
    }
    
    // === FUNÇÃO PRINCIPAL - PROCESSAR MENSAGEM ===
    async processarMensagem(message, remetente, grupoId) {
        try {
            const mensagem = message.body.trim();
            
            // Só processa grupos configurados
            if (!this.CONFIGURACAO_GRUPOS[grupoId]) {
                return null;
            }
            
            // FILTRO: Ignorar mensagens do sistema/bot
            if (/✅.*Transação Concluída Com Sucesso/i.test(mensagem) ||
                /✅.*Pedido processado/i.test(mensagem) ||
                /Transferencia Processada Automaticamente/i.test(mensagem) ||
                mensagem.startsWith('✅Saldo Transferido Com Sucesso') ||
                (/📱.*Número:/i.test(mensagem) && /📊.*Megas:/i.test(mensagem) && /💰.*Referência:/i.test(mensagem)) ||
                (/📱.*Número:/i.test(mensagem) && /📊.*Megas:/i.test(mensagem) && /🔖.*Referência:/i.test(mensagem))) {
                console.log(`🤖 DIVISÃO: Ignorando mensagem do sistema/bot de ${remetente}`);
                return { ignorado: true, processado: false };
            }
            
            console.log(`\n🔍 DIVISÃO: Analisando mensagem de ${remetente}`);
            
            // 1. DETECTAR SE É COMPROVATIVO SEM NÚMEROS
            const comprovativo = this.extrairComprovativo(mensagem);
            if (comprovativo && !this.temNumeros(mensagem)) {
                console.log(`💰 DIVISÃO: Comprovativo memorizado: ${comprovativo.referencia} - ${comprovativo.valor}MT`);
                const remetenteNormalizado = this.normalizarRemetente(remetente);
                this.comprovantesMemorizados[remetenteNormalizado] = {
                    ...comprovativo,
                    timestamp: Date.now(),
                    grupoId: grupoId
                };
                return null; // Não responde ainda
            }
            
            // 2. DETECTAR MÚLTIPLOS NÚMEROS (para verificar se precisa processar)
            const numerosDetectados = this.extrairMultiplosNumeros(mensagem, grupoId);
            
            // 3. PRIORIDADE: COMPROVATIVO + MÚLTIPLOS NÚMEROS NA MESMA MENSAGEM
            if (comprovativo && numerosDetectados && numerosDetectados.length > 1) {
                console.log(`🎯 DIVISÃO: Comprovativo + múltiplos números na mesma mensagem!`);
                console.log(`📱 DIVISÃO: ${numerosDetectados.length} números detectados: ${numerosDetectados.join(', ')}`);
                return await this.processarDivisao(comprovativo, numerosDetectados, grupoId, message);
            }
            
            // 4. CASO ALTERNATIVO: APENAS MÚLTIPLOS NÚMEROS (buscar comprovativo memorizado)
            if (numerosDetectados && numerosDetectados.length > 1 && !comprovativo) {
                console.log(`📱 DIVISÃO: ${numerosDetectados.length} números detectados sem comprovativo na mensagem`);
                
                // Procurar comprovativo memorizado
                const remetenteNormalizado = this.normalizarRemetente(remetente);
                let comprovantivoAssociado = this.comprovantesMemorizados[remetenteNormalizado];
                
                // Se não tem memorizado, buscar no histórico (últimos 30 min)
                if (!comprovantivoAssociado) {
                    comprovantivoAssociado = await this.buscarComprovanteRecenteHist(remetente);
                }
                
                if (comprovantivoAssociado) {
                    console.log(`✅ DIVISÃO: Comprovativo memorizado encontrado para divisão!`);
                    return await this.processarDivisao(comprovantivoAssociado, numerosDetectados, grupoId, message);
                } else {
                    console.log(`❌ DIVISÃO: Nenhum comprovativo encontrado para ${remetente}`);
                    return {
                        resposta: `📱 *${numerosDetectados.length} números detectados*\n\n❌ Não encontrei seu comprovativo nos últimos 30 minutos.\n\n🔍 Envie primeiro o comprovativo de pagamento.`
                    };
                }
            }
            
            return null; // Não é caso para divisão
            
        } catch (error) {
            console.error('❌ DIVISÃO: Erro ao processar mensagem:', error);
            return {
                resposta: '❌ Erro interno no sistema de divisão. Tente novamente.'
            };
        }
    }
    
    // === EXTRAIR COMPROVATIVO ===
    extrairComprovativo(mensagem) {
        const mensagemLimpa = mensagem.trim();
        console.log(`🔍 DIVISÃO: Verificando comprovativo em: "${mensagemLimpa.substring(0, 50)}..."`);
        
        const temConfirmado = /^confirmado/i.test(mensagemLimpa);
        const temID = /^id\s/i.test(mensagemLimpa);
        
        console.log(`🔍 DIVISÃO: temConfirmado: ${temConfirmado}, temID: ${temID}`);
        
        if (!temConfirmado && !temID) {
            console.log(`❌ DIVISÃO: Não é comprovativo (não começa com Confirmado ou ID)`);
            return null;
        }
        
        // Patterns para extrair referência e valor
        const patternsRef = [
            /Confirmado\s+([A-Z0-9]+)/i,
            /ID da transacao\s*:?\s*([A-Z0-9]+\.[A-Z0-9]+\.[A-Z0-9]+)/i,
            /ID da transacao\s*:?\s*([A-Z0-9]+\.[A-Z0-9]+)/i,
            /ID da transacao\s*:?\s*([A-Z0-9]+)/i
        ];
        
        const patternsValor = [
            // Padrão específico para "Transferiste" com vírgulas como separador de milhares
            /Transferiste\s+(\d+(?:,\d{3})*(?:\.\d+)?)MT/i,  // 1,250.00MT ou 1,000MT
            /Transferiste\s+(\d+,\d{3}(?:\.\d{2})?)MT/i,      // 1,250.00MT específico
            /Transferiste\s+(\d+(?:[.,]\d+)?)MT/i,            // Padrão original como fallback
            // Padrão genérico como última opção (pode pegar outros valores na mensagem)
            /(\d+(?:,\d{3})*(?:\.\d+)?)\s*MT/i               // 1,250.00 MT (genérico)
        ];
        
        let referencia = null;
        let valor = null;
        
        // Extrair referência
        for (const pattern of patternsRef) {
            const match = mensagem.match(pattern);
            if (match) {
                referencia = match[1];
                break;
            }
        }
        
        // Extrair valor
        for (const pattern of patternsValor) {
            const match = mensagem.match(pattern);
            if (match) {
                valor = this.normalizarValorInterno(match[1]);
                break;
            }
        }
        
        console.log(`🔍 DIVISÃO: Referência extraída: "${referencia}", Valor: ${valor}`);
        
        if (referencia && valor) {
            console.log(`✅ DIVISÃO: Comprovativo extraído com sucesso!`);
            return { referencia, valor };
        }
        
        console.log(`❌ DIVISÃO: Falha na extração - Referência: ${referencia}, Valor: ${valor}`);
        return null;
    }
    
    // === VERIFICAR SE TEM NÚMEROS ===
    temNumeros(mensagem) {
        const regex = /(?:\+258\s*)?8[0-9]{8}/g;
        const matches = mensagem.match(regex);
        return matches && matches.length > 0;
    }
    
    // === EXTRAIR MÚLTIPLOS NÚMEROS ===
    extrairMultiplosNumeros(mensagem, grupoId = null) {
        // 1. SEPARAR MENSAGEM DE CONFIRMAÇÃO DOS PEDIDOS
        const partesPedidos = this.separarConfirmacaoDosPedidos(mensagem);
        
        console.log(`📱 DIVISÃO: Confirmação encontrada: ${partesPedidos.temConfirmacao ? 'SIM' : 'NÃO'}`);
        console.log(`📱 DIVISÃO: Parte pedidos: "${partesPedidos.partePedidos.substring(0, 100)}..."`);
        
        // 2. EXTRAIR NÚMEROS APENAS DA PARTE DOS PEDIDOS
        const regex = /(?:\+258\s*)?8[0-9]{8}/g;
        const matches = partesPedidos.partePedidos.match(regex) || [];
        
        if (matches.length === 0) {
            console.log(`❌ DIVISÃO: Nenhum número encontrado na parte dos pedidos`);
            return null;
        }
        
        // 3. LIMPAR E FILTRAR NÚMEROS VÁLIDOS
        const numerosLimpos = matches.map(num => this.limparNumero(num))
                                    .filter(num => num && /^8[0-9]{8}$/.test(num));
        
        // 4. REMOVER DUPLICATAS
        const numerosUnicos = [...new Set(numerosLimpos)];
        
        // 5. FILTRAR NÚMEROS DE PAGAMENTO DO GRUPO (ainda necessário)
        const numerosFiltrados = this.filtrarNumerosPagamentoGrupo(numerosUnicos, grupoId);
        
        console.log(`📱 DIVISÃO: ${matches.length} números encontrados na parte pedidos`);
        console.log(`📱 DIVISÃO: ${numerosLimpos.length} números válidos após limpeza`);
        console.log(`📱 DIVISÃO: ${numerosUnicos.length} números únicos: [${numerosUnicos.join(', ')}]`);
        console.log(`📱 DIVISÃO: ${numerosFiltrados.length} números finais aceitos: [${numerosFiltrados.join(', ')}]`);
        
        return numerosFiltrados.length > 0 ? numerosFiltrados : null;
    }
    
    // === SEPARAR CONFIRMAÇÃO DOS PEDIDOS ===
    separarConfirmacaoDosPedidos(mensagem) {
        // Detectar se há mensagem de confirmação
        const temConfirmacao = /^(confirmado|id\s)/i.test(mensagem.trim());
        
        if (!temConfirmacao) {
            // Se não há confirmação, toda mensagem é considerada parte dos pedidos
            return {
                temConfirmacao: false,
                parteConfirmacao: '',
                partePedidos: mensagem
            };
        }
        
        // Padrões que indicam o FIM da mensagem de confirmação
        const padroesFimConfirmacao = [
            // Fim por ponto seguido de quebra de linha ou espaço
            /\.\s*\n/,
            /\.\s*$/,
            
            // Fim por "Saldo" (comum em mensagens M-Pesa/eMola)
            /saldo[\s\S]*?\n/i,
            /saldo[\s\S]*?$/i,
            
            // Fim por "Taxa" ou "Tarifa"
            /taxa[\s\S]*?\n/i,
            /taxa[\s\S]*?$/i,
            /tarifa[\s\S]*?\n/i,
            /tarifa[\s\S]*?$/i,
            
            // Fim por "Obrigado" ou "Agradecemos"
            /obrigad[oa][\s\S]*?\n/i,
            /obrigad[oa][\s\S]*?$/i,
            /agradecemos[\s\S]*?\n/i,
            /agradecemos[\s\S]*?$/i,
            
            // Fim por timestamps ou identificadores técnicos
            /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}/,
            /ref[\s\.:]*[A-Z0-9]{8,}/i,
            
            // Fim por linhas de separação ou divisória
            /[-=_]{3,}/,
            
            // Fim por padrões específicos de fim de SMS
            /fim\s*$/i,
            /\s*\*\s*$/,
            
            // Quebra natural - duas quebras de linha consecutivas
            /\n\s*\n/
        ];
        
        let posicaoFim = mensagem.length; // Por padrão, toda mensagem é confirmação
        let padraoEncontrado = 'fim da mensagem';
        
        // Encontrar o primeiro padrão que indica fim da confirmação
        for (const padrao of padroesFimConfirmacao) {
            const match = mensagem.search(padrao);
            if (match !== -1 && match < posicaoFim) {
                posicaoFim = match;
                const matchContent = mensagem.match(padrao);
                if (matchContent) {
                    posicaoFim = match + matchContent[0].length;
                }
                padraoEncontrado = padrao.source;
                break;
            }
        }
        
        const parteConfirmacao = mensagem.substring(0, posicaoFim).trim();
        const partePedidos = mensagem.substring(posicaoFim).trim();
        
        console.log(`🔍 DIVISÃO: Confirmação detectada - separação por: ${padraoEncontrado}`);
        console.log(`📄 DIVISÃO: Parte confirmação (${parteConfirmacao.length} chars): "${parteConfirmacao.substring(0, 80)}..."`);
        console.log(`📋 DIVISÃO: Parte pedidos (${partePedidos.length} chars): "${partePedidos.substring(0, 80)}..."`);
        
        return {
            temConfirmacao: true,
            parteConfirmacao,
            partePedidos
        };
    }
    
    // === FILTRAR APENAS NÚMEROS DE PAGAMENTO DO GRUPO ===
    filtrarNumerosPagamentoGrupo(numeros, grupoId) {
        if (!grupoId || !this.CONFIGURACAO_GRUPOS[grupoId] || !this.CONFIGURACAO_GRUPOS[grupoId].numerosPagamento) {
            return numeros; // Se não há configuração, aceita todos
        }
        
        const numerosPagamentoGrupo = this.CONFIGURACAO_GRUPOS[grupoId].numerosPagamento;
        
        return numeros.filter(numero => {
            // Testar número completo e versões sem prefixo
            const numeroSemPrefixo = numero.length > 9 ? numero.substring(numero.length - 9) : numero;
            const numeroCompleto = numero.startsWith('258') ? numero : '258' + numero;
            
            const ehNumeroPagamento = numerosPagamentoGrupo.includes(numero) || 
                                     numerosPagamentoGrupo.includes(numeroSemPrefixo) || 
                                     numerosPagamentoGrupo.includes(numeroCompleto);
            
            if (ehNumeroPagamento) {
                console.log(`🚫 DIVISÃO: ${numero} ignorado (número de pagamento do grupo)`);
                return false;
            }
            
            console.log(`✅ DIVISÃO: ${numero} aceito para divisão`);
            return true;
        });
    }
    
    // === FILTRAR NÚMEROS DE COMPROVANTE ===
    filtrarNumerosComprovante(numeros, mensagem, grupoId = null) {
        // 1. IDENTIFICAR NÚMERO QUE RECEBEU O PAGAMENTO (da mensagem de confirmação)
        const numeroReceptorPagamento = this.identificarNumeroReceptorPagamento(mensagem);
        
        console.log(`🔍 DIVISÃO: Número receptor de pagamento identificado: ${numeroReceptorPagamento || 'nenhum'}`);
        
        return numeros.filter(numero => {
            // 2. VERIFICAR SE É NÚMERO DE PAGAMENTO DO GRUPO
            if (grupoId && this.CONFIGURACAO_GRUPOS[grupoId] && this.CONFIGURACAO_GRUPOS[grupoId].numerosPagamento) {
                const numerosPagamentoGrupo = this.CONFIGURACAO_GRUPOS[grupoId].numerosPagamento;
                // Testar número completo e versões sem prefixo
                const numeroSemPrefixo = numero.length > 9 ? numero.substring(numero.length - 9) : numero;
                const numeroCompleto = numero.startsWith('258') ? numero : '258' + numero;
                
                if (numerosPagamentoGrupo.includes(numero) || 
                    numerosPagamentoGrupo.includes(numeroSemPrefixo) || 
                    numerosPagamentoGrupo.includes(numeroCompleto)) {
                    console.log(`🚫 DIVISÃO: ${numero} ignorado (número de pagamento do grupo)`);
                    return false;
                }
            }
            
            // 3. IGNORAR APENAS O NÚMERO QUE RECEBEU O PAGAMENTO
            if (numeroReceptorPagamento && 
                (numero === numeroReceptorPagamento || 
                 numero === numeroReceptorPagamento.replace(/^258/, '') ||
                 ('258' + numero) === numeroReceptorPagamento)) {
                console.log(`🚫 DIVISÃO: ${numero} ignorado (número que recebeu o pagamento)`);
                return false;
            }
            
            // 4. TODOS OS OUTROS NÚMEROS SÃO ACEITOS (mesmo que sejam 10+)
            console.log(`✅ DIVISÃO: ${numero} aceito para divisão`);
            return true;
        });
    }
    
    // === IDENTIFICAR NÚMERO QUE RECEBEU O PAGAMENTO ===
    identificarNumeroReceptorPagamento(mensagem) {
        // Padrões para identificar o número receptor na mensagem de confirmação
        const padroesPagamento = [
            // M-Pesa patterns
            /M-Pesa.*?(\d{9})\s*-/i,                                    // "M-Pesa ... 840326152 - NOME"
            /para\s+(\d{9})\s*-/i,                                      // "para 840326152 - NOME"
            /Transferiste.*?para\s+(\d{9})\s*-/i,                       // "Transferiste ... para 840326152 - NOME"
            
            // eMola patterns
            /eMola.*?(\d{9})\s*-/i,                                     // "eMola ... 840326152 - NOME"
            /conta\s+(\d{9})/i,                                         // "conta 840326152"
            
            // Padrões gerais de transferência
            /(?:transferiu|transferiste|enviou|pagou).*?(\d{9})\s*[-,]/i, // Verbos de transferência seguidos de número
            /destinatário.*?(\d{9})/i,                                   // "destinatário 840326152"
            /beneficiário.*?(\d{9})/i,                                   // "beneficiário 840326152"
            
            // Padrão: número seguido de hífen e nome conhecido
            /(\d{9})\s*-\s*(?:VASCO|Mahumane|Alice|Natacha|Admin|Conta)/i
        ];
        
        for (const padrao of padroesPagamento) {
            const match = mensagem.match(padrao);
            if (match) {
                const numeroEncontrado = this.limparNumero(match[1]);
                console.log(`🎯 DIVISÃO: Número receptor encontrado: ${numeroEncontrado} (padrão: ${padrao.source})`);
                return numeroEncontrado;
            }
        }
        
        console.log(`❌ DIVISÃO: Nenhum número receptor identificado na mensagem`);
        return null;
    }
    
    // === LIMPAR NÚMERO ===
    limparNumero(numero) {
        if (!numero || typeof numero !== 'string') return numero;
        
        return numero
            .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // Caracteres invisíveis
            .replace(/^\+258\s*/, '') // Remove +258
            .replace(/\s+/g, '') // Remove espaços
            .trim();
    }
    
    // === BUSCAR COMPROVATIVO NO HISTÓRICO (SIMULADO) ===
    async buscarComprovanteRecenteHist(remetente) {
        console.log(`🔍 DIVISÃO: Buscando comprovativo para remetente: ${remetente}`);
        
        // Mostrar detalhes dos comprovativos memorizados
        const chaves = Object.keys(this.comprovantesMemorizados);
        console.log(`📋 DIVISÃO: ${chaves.length} comprovativos memorizados:`);
        chaves.forEach(chave => {
            const comp = this.comprovantesMemorizados[chave];
            const idade = ((Date.now() - comp.timestamp) / 60000).toFixed(1);
            console.log(`   • ${chave}: ${comp.referencia} (${comp.valor}MT) - ${idade}min atrás`);
        });
        
        // Normalizar o remetente atual para busca
        const remetenteNormalizado = this.normalizarRemetente(remetente);
        console.log(`🔄 DIVISÃO: Remetente original: ${remetente}`);
        console.log(`🔄 DIVISÃO: Remetente normalizado: ${remetenteNormalizado}`);
        
        // Buscar usando a chave normalizada
        const comprovativo = this.comprovantesMemorizados[remetenteNormalizado];
        // Verificar se ainda está dentro do prazo (30 min)
        if (comprovativo && (Date.now() - comprovativo.timestamp) <= 1800000) {
            console.log(`✅ DIVISÃO: Comprovativo encontrado dentro do prazo!`);
            console.log(`   Ref: ${comprovativo.referencia}, Valor: ${comprovativo.valor}MT, Fonte: ${comprovativo.fonte || 'não definida'}`);
            return comprovativo;
        } else if (comprovativo) {
            const minutosExpiracao = (Date.now() - comprovativo.timestamp) / 60000;
            console.log(`❌ DIVISÃO: Comprovativo encontrado mas expirado (${minutosExpiracao.toFixed(1)} min)`);
        } else {
            console.log(`❌ DIVISÃO: Nenhum comprovativo encontrado para remetente normalizado "${remetenteNormalizado}"`);
        }
        
        return null;
    }
    
    // === PROCESSAR DIVISÃO ===
    async processarDivisao(comprovativo, numeros, grupoId, message) {
        const inicioProcessamento = Date.now(); // OTIMIZAÇÃO: Timestamp para velocidade
        const chaveProcessamento = `${comprovativo.referencia}_${numeros.join('_')}`;
        
        // Evitar processamento duplicado
        if (this.processandoDivisoes.has(chaveProcessamento)) {
            return { resposta: '⏳ Divisão já em processamento...' };
        }
        
        this.processandoDivisoes.add(chaveProcessamento);
        
        try {
            console.log(`🔄 DIVISÃO: Iniciando processamento de ${comprovativo.referencia}`);
            
            // 1. CONFIRMAR PAGAMENTO EXISTE
            const pagamentoExiste = await this.buscarPagamentoNaPlanilha(
                comprovativo.referencia,
                comprovativo.valor
            );

            // CASO ESPECIAL: Pagamento já foi processado
            if (pagamentoExiste === 'ja_processado') {
                console.log(`⚠️ DIVISÃO: Pagamento já processado - ${comprovativo.referencia}`);
                return {
                    resposta: `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n💰 Referência: ${comprovativo.referencia}\n💳 Valor: ${comprovativo.valor}MT\n\n✅ Este pagamento já foi processado anteriormente. Não é necessário enviar novamente.\n\nSe você acredita que isso é um erro, entre em contato com o suporte.`
                };
            }

            if (!pagamentoExiste) {
                console.log(`⏳ DIVISÃO: Pagamento não encontrado, aguardando...`);
                return {
                    resposta: `⏳ *PAGAMENTO NÃO ENCONTRADO*\n\n💰 Referência: ${comprovativo.referencia}\n💳 Valor: ${comprovativo.valor}MT\n\n🔍 Aguardando confirmação do pagamento...`
                };
            }
            
            console.log(`✅ DIVISÃO: Pagamento confirmado!`);
            
            // 2. VALIDAR SE O VALOR EXISTE NA TABELA DE PREÇOS (NOVA VALIDAÇÃO CRÍTICA)
            const configGrupo = this.CONFIGURACAO_GRUPOS[grupoId];
            if (!configGrupo || !configGrupo.precos) {
                return {
                    resposta: `❌ *GRUPO NÃO CONFIGURADO*\n\n🚫 Grupo ${grupoId} não tem tabela de preços configurada.`
                };
            }
            
            const valoresValidos = Object.values(configGrupo.precos);
            const valorExisteNaTabela = valoresValidos.includes(comprovativo.valor);
            
            if (!valorExisteNaTabela) {
                console.error(`❌ DIVISÃO: Valor ${comprovativo.valor}MT não existe na tabela de preços do grupo`);
                console.log(`📋 DIVISÃO: Valores válidos: ${valoresValidos.join(', ')}MT`);
                
                return {
                    resposta: `❌ *VALOR DESCONHECIDO*\n\n💰 **${comprovativo.valor}MT** não existe na nossa tabela de preços.\n\n📋 **Valores válidos:**\n${valoresValidos.map(v => `• ${v}MT`).join('\n')}\n\n🔄 Faça um novo pagamento com valor correto.`
                };
            }
            
            console.log(`✅ DIVISÃO: Valor ${comprovativo.valor}MT é válido na tabela de preços`);
            
            // 3. CALCULAR DIVISÃO COM ESPECIFICAÇÕES INDIVIDUAIS (NOVA LÓGICA)
            const mensagemCompleta = message.body || '';
            const divisao = this.calcularDivisaoComEspecificacoes(comprovativo.valor, numeros, grupoId, mensagemCompleta);
            
            if (!divisao || divisao.length === 0) {
                return {
                    resposta: `❌ *ERRO NO CÁLCULO*\n\n💰 Valor ${comprovativo.valor}MT não pode ser dividido pelos números informados.\n\n📋 Verifique a tabela de preços do grupo.`
                };
            }
            
            console.log(`🧮 DIVISÃO: ${divisao.length} divisões calculadas antes da subdivisão`);
            
            // 4. SUBDIVIDIR EM BLOCOS DE 10GB (NOVA FUNCIONALIDADE CRÍTICA)
            const subdivisoes = this.subdividirEmBlocosDE10GB(divisao, comprovativo.referencia);
            
            if (!subdivisoes || subdivisoes.length === 0) {
                return {
                    resposta: `❌ *ERRO NA SUBDIVISÃO*\n\n🔧 Falha ao subdividir pedidos em blocos de 10GB.\n\n⚙️ Problema técnico interno.`
                };
            }
            
            console.log(`🔧 SUBDIVISÃO: ${divisao.length} divisões → ${subdivisoes.length} blocos finais`);
            
            // 5. RESPOSTA IMEDIATA (OTIMIZADA PARA VELOCIDADE)
            console.log(`🚀 DIVISÃO: Enviando resposta imediata ao WhatsApp`);
            
            let mensagemImediata = `✅ *DIVISÃO INICIADA!*\n\n`;
            mensagemImediata += `💰 **${comprovativo.referencia}** - ${comprovativo.valor}MT\n`;
            mensagemImediata += `📱 **${numeros.length} números** detectados\n\n`;
            
            // Mostrar divisão de forma compacta
            mensagemImediata += `⚡ **Divisão:**\n`;
            divisao.slice(0, 5).forEach((item, i) => {
                mensagemImediata += `   • ${item.numero}: ${item.megasTexto}\n`;
            });
            if (divisao.length > 5) {
                mensagemImediata += `   • ... e mais ${divisao.length - 5} números\n`;
            }
            
            if (subdivisoes.length > divisao.length) {
                mensagemImediata += `\n🔧 **${subdivisoes.length} blocos de 10GB criados**\n`;
            }
            
            mensagemImediata += `\n🚀 *Processando em paralelo...*\n`;
            mensagemImediata += `⏱️ *Aguarde ~${Math.ceil(subdivisoes.length/5)*10}s para conclusão*`;
            
            // ENVIAR RESPOSTA IMEDIATA (NÃO BLOQUEIA PROCESSAMENTO)
            try {
                await message.reply(mensagemImediata);
                console.log(`✅ DIVISÃO: Resposta imediata enviada em ${Date.now() - inicioProcessamento}ms`);
            } catch (error) {
                console.error(`❌ DIVISÃO: Erro ao enviar resposta imediata:`, error.message);
            }
            
            // 6. PROCESSAMENTO EM BACKGROUND (OTIMIZADO PARA VELOCIDADE)
            console.log(`🚀 DIVISÃO: Iniciando processamento em background de ${subdivisoes.length} blocos`);

            // EXECUTAR EM BACKGROUND - NÃO BLOQUEIA A RESPOSTA
            this.processarPedidosEmBackground(subdivisoes, grupoId, comprovativo.referencia, comprovativo.valor, message);
            
            // 7. RESPOSTA RÁPIDA (PROCESSAMENTO CONTINUA EM BACKGROUND)
            const remetenteLimpeza = this.normalizarRemetente(message.author || message.from);
            delete this.comprovantesMemorizados[remetenteLimpeza];
            
            const tempoResposta = Date.now() - inicioProcessamento;
            console.log(`⚡ DIVISÃO: Resposta enviada em ${tempoResposta}ms - processamento continua em background`);
            
            return { 
                processado: true, 
                resposta_imediata: true,
                tempo_resposta_ms: tempoResposta,
                blocos_em_processamento: subdivisoes.length
            };
            
        } catch (error) {
            console.error('❌ DIVISÃO: Erro no processamento:', error);
            return {
                resposta: `❌ *ERRO NO PROCESSAMENTO*\n\n${error.message}`
            };
        } finally {
            this.processandoDivisoes.delete(chaveProcessamento);
        }
    }
    
    // === BUSCAR PAGAMENTO NA PLANILHA ===
    async buscarPagamentoNaPlanilha(referencia, valorEsperado) {
        try {
            console.log(`🔍 DIVISÃO: Buscando pagamento ${referencia} - ${valorEsperado}MT`);

            const resultado = await this.tentarComRetry(
                async (timeout) => {
                    const response = await axios.post(this.SCRIPTS_CONFIG.PAGAMENTOS, {
                        action: "buscar_por_referencia",
                        referencia: referencia,
                        valor: valorEsperado
                    }, {
                        timeout: timeout,
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    if (response.data && response.data.encontrado) {
                        // VERIFICAR SE PAGAMENTO JÁ FOI PROCESSADO
                        if (response.data.ja_processado) {
                            console.log(`⚠️ DIVISÃO: Pagamento já foi processado anteriormente!`);
                            return 'ja_processado';
                        }

                        console.log(`✅ DIVISÃO: Pagamento encontrado (ainda não marcado como processado)!`);
                        return true;
                    }

                    console.log(`❌ DIVISÃO: Pagamento não encontrado`);
                    return false;
                },
                `Busca de pagamento ${referencia}`,
                2 // Apenas 2 tentativas para busca
            );

            return resultado;

        } catch (error) {
            console.error(`❌ DIVISÃO: Erro ao buscar pagamento após tentativas:`, error.message);
            return false;
        }
    }

    // === MARCAR PAGAMENTO COMO PROCESSADO ===
    async marcarPagamentoComoProcessado(referencia, valorEsperado) {
        try {
            console.log(`✅ DIVISÃO: Marcando pagamento ${referencia} como processado`);

            const response = await axios.post(this.SCRIPTS_CONFIG.PAGAMENTOS, {
                action: "marcar_processado",
                referencia: referencia,
                valor: valorEsperado
            }, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.success) {
                console.log(`✅ DIVISÃO: Pagamento marcado como processado com sucesso!`);
                return true;
            }

            console.log(`⚠️ DIVISÃO: Falha ao marcar pagamento como processado`);
            return false;

        } catch (error) {
            console.error(`❌ DIVISÃO: Erro ao marcar pagamento como processado:`, error.message);
            return false;
        }
    }
    
    // === CALCULAR DIVISÃO COM ESPECIFICAÇÕES INDIVIDUAIS ===
    calcularDivisaoComEspecificacoes(valorTotal, numeros, grupoId, mensagemCompleta = '') {
        try {
            const configGrupo = this.CONFIGURACAO_GRUPOS[grupoId];
            if (!configGrupo || !configGrupo.precos) {
                console.error(`❌ DIVISÃO: Grupo ${grupoId} não configurado`);
                return null;
            }
            
            console.log(`🧮 DIVISÃO: Iniciando cálculo com especificações para ${numeros.length} números`);
            
            // 1. EXTRAIR ESPECIFICAÇÕES INDIVIDUAIS DA MENSAGEM
            const especificacoes = this.extrairEspecificacoes(mensagemCompleta, numeros);
            
            // 2. VERIFICAR SE TEM ESPECIFICAÇÕES VÁLIDAS
            const numerosComEspecificacao = Object.keys(especificacoes);
            
            if (numerosComEspecificacao.length > 0) {
                console.log(`🎯 DIVISÃO: Usando especificações individuais para ${numerosComEspecificacao.length}/${numeros.length} números`);
                return this.calcularDivisaoPorEspecificacoes(valorTotal, numeros, especificacoes, configGrupo);
            } else {
                console.log(`⚖️ DIVISÃO: Nenhuma especificação encontrada, usando divisão por prioridade`);
                return this.calcularDivisaoPorPrioridade(valorTotal, numeros, grupoId);
            }
            
        } catch (error) {
            console.error(`❌ DIVISÃO: Erro no cálculo com especificações:`, error);
            return null;
        }
    }
    
    // === CALCULAR DIVISÃO POR ESPECIFICAÇÕES INDIVIDUAIS ===
    calcularDivisaoPorEspecificacoes(valorTotal, numeros, especificacoes, configGrupo) {
        try {
            console.log(`📋 DIVISÃO: Calculando com especificações individuais`);
            
            const resultado = [];
            let valorRestante = valorTotal;
            let megasRestante = null;
            
            // Converter valor total para megas
            for (const [megas, preco] of Object.entries(configGrupo.precos)) {
                if (preco === valorTotal) {
                    megasRestante = parseInt(megas);
                    break;
                }
            }
            
            if (!megasRestante) {
                console.error(`❌ DIVISÃO: Valor ${valorTotal}MT não encontrado na tabela`);
                return null;
            }
            
            console.log(`📊 DIVISÃO: ${valorTotal}MT = ${megasRestante}MB total disponível`);
            
            // 1. PROCESSAR NÚMEROS COM ESPECIFICAÇÕES
            for (const numero of numeros) {
                if (especificacoes[numero]) {
                    const megasSolicitadas = especificacoes[numero];
                    
                    // Encontrar valor em MT correspondente
                    let valorMT = null;
                    for (const [megas, preco] of Object.entries(configGrupo.precos)) {
                        if (parseInt(megas) === megasSolicitadas) {
                            valorMT = preco;
                            break;
                        }
                    }
                    
                    if (valorMT === null) {
                        console.error(`❌ DIVISÃO: Não encontrou preço para ${megasSolicitadas}MB (${numero})`);
                        return null;
                    }
                    
                    if (valorMT > valorRestante) {
                        console.error(`❌ DIVISÃO: Valor insuficiente para ${numero} (precisa ${valorMT}MT, restam ${valorRestante}MT)`);
                        return null;
                    }
                    
                    resultado.push({
                        numero: numero,
                        megas: megasSolicitadas,
                        megasTexto: `${megasSolicitadas / 1024}GB`,
                        valorMT: valorMT
                    });
                    
                    valorRestante -= valorMT;
                    megasRestante -= megasSolicitadas;
                    
                    console.log(`   ✅ ${numero}: ${megasSolicitadas/1024}GB (${valorMT}MT) - Restante: ${valorRestante}MT`);
                }
            }
            
            // 2. PROCESSAR NÚMEROS SEM ESPECIFICAÇÕES (se houver)
            const numerosSemEspecificacao = numeros.filter(numero => !especificacoes[numero]);
            
            if (numerosSemEspecificacao.length > 0 && (valorRestante > 0 || megasRestante > 0)) {
                console.log(`⚖️ DIVISÃO: Distribuindo restante (${valorRestante}MT/${megasRestante}MB) entre ${numerosSemEspecificacao.length} números`);
                
                const divisaoRestante = this.calcularDivisaoPorPrioridade(valorRestante, numerosSemEspecificacao, null, configGrupo, megasRestante);
                
                if (divisaoRestante) {
                    resultado.push(...divisaoRestante);
                }
            }
            
            // 3. VERIFICAR SE A DIVISÃO ESTÁ CORRETA
            const somaValores = resultado.reduce((sum, item) => sum + item.valorMT, 0);
            if (somaValores !== valorTotal) {
                console.error(`❌ DIVISÃO: Soma ${somaValores}MT ≠ Total ${valorTotal}MT`);
                return null;
            }
            
            console.log(`✅ DIVISÃO: Cálculo por especificações concluído - ${resultado.length} divisões`);
            return resultado;
            
        } catch (error) {
            console.error(`❌ DIVISÃO: Erro no cálculo por especificações:`, error);
            return null;
        }
    }
    
    // === CALCULAR DIVISÃO POR PRIORIDADE (MANTIDA PARA COMPATIBILIDADE) ===
    calcularDivisaoPorPrioridade(valorTotal, numeros, grupoId, configGrupo = null, megasDisponivel = null) {
        try {
            // Se não recebeu configGrupo, buscar pelo grupoId
            if (!configGrupo) {
                configGrupo = this.CONFIGURACAO_GRUPOS[grupoId];
                if (!configGrupo || !configGrupo.precos) {
                    console.error(`❌ DIVISÃO: Grupo ${grupoId} não configurado`);
                    return null;
                }
            }
            
            // Converter valor para megas total (se não foi fornecido)
            let megasTotal = megasDisponivel;
            if (!megasTotal) {
                for (const [megas, preco] of Object.entries(configGrupo.precos)) {
                    if (preco === valorTotal) {
                        megasTotal = parseInt(megas);
                        break;
                    }
                }
            }
            
            if (!megasTotal) {
                console.error(`❌ DIVISÃO: Valor ${valorTotal}MT não encontrado na tabela`);
                return null;
            }
            
            console.log(`📊 DIVISÃO: ${valorTotal}MT = ${megasTotal}MB total para ${numeros.length} números`);
            
            // Calcular divisão base
            const megasPorNumero = Math.floor(megasTotal / numeros.length);
            const megasBase = Math.floor(megasPorNumero / 10240) * 10240; // Arredondar para múltiplo de 10GB
            const megasRestante = megasTotal - (megasBase * numeros.length);
            
            console.log(`📊 DIVISÃO: Base ${megasBase}MB cada, restante ${megasRestante}MB`);
            
            // Distribuir por prioridade
            const resultado = [];
            for (let i = 0; i < numeros.length; i++) {
                let megasFinais = megasBase;
                
                // Distribuir restante por prioridade (primeiros números recebem mais)
                if (megasRestante > 0 && i < Math.floor(megasRestante / 10240)) {
                    megasFinais += 10240; // +10GB
                }
                
                // Encontrar valor em MT correspondente
                let valorMT = null;
                let megasTexto = '';
                
                for (const [megas, preco] of Object.entries(configGrupo.precos)) {
                    if (parseInt(megas) === megasFinais) {
                        valorMT = preco;
                        megasTexto = `${megasFinais / 1024}GB`;
                        break;
                    }
                }
                
                if (valorMT === null) {
                    console.error(`❌ DIVISÃO: Não encontrou preço para ${megasFinais}MB`);
                    return null;
                }
                
                resultado.push({
                    numero: numeros[i],
                    megas: megasFinais,
                    megasTexto: megasTexto,
                    valorMT: valorMT
                });
            }
            
            // Verificar se a divisão está correta (apenas se for divisão completa)
            if (!megasDisponivel) {
                const somaValores = resultado.reduce((sum, item) => sum + item.valorMT, 0);
                if (somaValores !== valorTotal) {
                    console.error(`❌ DIVISÃO: Soma ${somaValores}MT ≠ Total ${valorTotal}MT`);
                    return null;
                }
            }
            
            console.log(`✅ DIVISÃO: Cálculo concluído - ${resultado.length} divisões`);
            return resultado;
            
        } catch (error) {
            console.error(`❌ DIVISÃO: Erro no cálculo:`, error);
            return null;
        }
    }
    
    // === SUBDIVIDIR EM BLOCOS DE 10GB (NOVA FUNCIONALIDADE CRÍTICA) ===
    subdividirEmBlocosDE10GB(divisoesOriginais, referenciaBase) {
        try {
            console.log(`🔧 SUBDIVISÃO: Iniciando subdivisão em blocos de 10GB para ${divisoesOriginais.length} divisões`);
            
            const subdivisoes = [];
            let contadorGlobal = 1;
            
            for (const divisao of divisoesOriginais) {
                const { numero, megas, valorMT } = divisao;
                
                // Se for 10GB ou menos, não precisa subdividir
                if (megas <= 10240) {
                    subdivisoes.push({
                        ...divisao,
                        referenciaFinal: referenciaBase + String(contadorGlobal).padStart(3, '0'),
                        ehSubdivisao: false,
                        blocoOriginal: contadorGlobal
                    });
                    contadorGlobal++;
                    console.log(`   ✅ ${numero}: ${megas/1024}GB - Mantido sem subdivisão`);
                    continue;
                }
                
                // CORREÇÃO: Subdividir em blocos EXATOS de 10GB
                console.log(`   🔧 ${numero}: ${megas/1024}GB → Criando blocos de EXATAMENTE 10GB`);

                let megasRestantes = megas;
                let valorRestante = valorMT;
                let contadorSubBloco = 1;

                // Criar blocos de exatamente 10GB
                while (megasRestantes > 0) {
                    const megasBloco = megasRestantes >= 10240 ? 10240 : megasRestantes;

                    // Calcular valor proporcional para este bloco
                    const proporcao = megasBloco / megas;
                    const valorBloco = Math.round(valorMT * proporcao);

                    const novaReferencia = referenciaBase + String(contadorGlobal).padStart(3, '0') + String(contadorSubBloco);

                    subdivisoes.push({
                        numero: numero,
                        megas: megasBloco,
                        megasTexto: `${megasBloco/1024}GB`,
                        valorMT: valorBloco,
                        referenciaFinal: novaReferencia,
                        ehSubdivisao: true,
                        blocoOriginal: contadorGlobal,
                        indiceBlocoSubdivisao: contadorSubBloco,
                        totalBlocosSubdivisao: Math.ceil(megas / 10240)
                    });

                    console.log(`      📦 Bloco ${contadorSubBloco}: ${novaReferencia} - ${megasBloco/1024}GB (${valorBloco}MT)`);

                    megasRestantes -= megasBloco;
                    valorRestante -= valorBloco;
                    contadorSubBloco++;
                }

                contadorGlobal++;
            }
            
            // Validar se a subdivisão preservou os totais
            const megasOriginais = divisoesOriginais.reduce((sum, div) => sum + div.megas, 0);
            const valorOriginal = divisoesOriginais.reduce((sum, div) => sum + div.valorMT, 0);
            const megasSubdivididas = subdivisoes.reduce((sum, sub) => sum + sub.megas, 0);
            const valorSubdividido = subdivisoes.reduce((sum, sub) => sum + sub.valorMT, 0);
            
            if (Math.abs(megasOriginais - megasSubdivididas) > 10 || Math.abs(valorOriginal - valorSubdividido) > 5) {
                console.error(`❌ SUBDIVISÃO: Erro de validação!`);
                console.error(`   Megas: ${megasOriginais}MB → ${megasSubdivididas}MB (diff: ${megasOriginais - megasSubdivididas}MB)`);
                console.error(`   Valor: ${valorOriginal}MT → ${valorSubdividido}MT (diff: ${valorOriginal - valorSubdividido}MT)`);
                return null;
            }
            
            // Verificar se TODOS os blocos são ≤10GB
            const blocosExcedentes = subdivisoes.filter(sub => sub.megas > 10240);
            if (blocosExcedentes.length > 0) {
                console.error(`❌ SUBDIVISÃO: ${blocosExcedentes.length} blocos excedem 10GB:`);
                blocosExcedentes.forEach(bloco => {
                    console.error(`   • ${bloco.referenciaFinal}: ${bloco.megas/1024}GB (${bloco.numero})`);
                });
                return null;
            }
            
            console.log(`✅ SUBDIVISÃO: Concluída com sucesso!`);
            console.log(`   📊 ${divisoesOriginais.length} divisões → ${subdivisoes.length} blocos (máx 10GB cada)`);
            console.log(`   🔍 Validação: ${megasOriginais/1024}GB/${valorOriginal}MT mantidos`);
            
            return subdivisoes;
            
        } catch (error) {
            console.error(`❌ SUBDIVISÃO: Erro na subdivisão:`, error);
            return null;
        }
    }

    // === PROCESSAMENTO EM BACKGROUND (NOVA FUNÇÃO) ===
    async processarPedidosEmBackground(subdivisoes, grupoId, referenciaOriginal, valorOriginal, message) {
        const inicioBackground = Date.now();
        let sucessos = 0;
        let duplicados = 0;
        let erros = 0;
        let pedidosDuplicados = [];
        
        try {
            console.log(`🔄 BACKGROUND: Processando ${subdivisoes.length} pedidos em paralelo`);
            
            // PROCESSAMENTO PARALELO EM BACKGROUND
            const promessasProcessamento = subdivisoes.map(async ({ numero, megas, valorMT, referenciaFinal }, i) => {
                const logPrefix = `📝 BG [${i + 1}/${subdivisoes.length}]`;
                
                try {
                    const resultadoPedido = await this.enviarParaPlanilhaPedidos(referenciaFinal, megas, numero, grupoId);
                    
                    // Verificar se foi duplicado
                    const pedidoDuplicado = resultadoPedido && resultadoPedido.duplicado;
                    
                    if (pedidoDuplicado) {
                        console.log(`⚠️ ${logPrefix}: ${referenciaFinal} já existia (duplicado)`);
                        return {
                            tipo: 'duplicado',
                            referencia: referenciaFinal,
                            numero: numero,
                            status: resultadoPedido.status || 'Existente'
                        };
                    } else {
                        console.log(`✅ ${logPrefix}: ${referenciaFinal} criado com sucesso`);
                        return { tipo: 'sucesso', referencia: referenciaFinal };
                    }
                    
                } catch (error) {
                    console.error(`❌ ${logPrefix}: Erro ao processar ${referenciaFinal}:`, error.message);
                    
                    if (error.message && (error.message.includes('Duplicado') || error.message.includes('já existe'))) {
                        return {
                            tipo: 'duplicado',
                            referencia: referenciaFinal,
                            numero: numero,
                            status: 'Existente'
                        };
                    } else {
                        return {
                            tipo: 'erro',
                            referencia: referenciaFinal,
                            numero: numero,
                            erro: error.message
                        };
                    }
                }
            });
            
            // Aguardar todos os processamentos
            const resultados = await Promise.allSettled(promessasProcessamento);
            
            // Processar resultados
            resultados.forEach((resultado, i) => {
                if (resultado.status === 'fulfilled') {
                    const res = resultado.value;
                    switch (res.tipo) {
                        case 'sucesso':
                            sucessos++;
                            break;
                        case 'duplicado':
                            duplicados++;
                            pedidosDuplicados.push(res);
                            break;
                        case 'erro':
                            erros++;
                            break;
                    }
                } else {
                    erros++;
                }
            });
            
            const tempoTotal = Date.now() - inicioBackground;
            console.log(`🏁 BACKGROUND: Concluído em ${tempoTotal}ms - ✅${sucessos} ⚠️${duplicados} ❌${erros}`);

            // MARCAR PAGAMENTO COMO PROCESSADO (somente se teve sucesso)
            if (sucessos > 0 || duplicados > 0) {
                console.log(`🔄 BACKGROUND: Marcando pagamento ${referenciaOriginal} como processado...`);
                await this.marcarPagamentoComoProcessado(referenciaOriginal, valorOriginal);
            }

            // ENVIAR MENSAGEM FINAL DE CONCLUSÃO
            await this.enviarMensagemConclusao(message, sucessos, duplicados, erros, pedidosDuplicados, subdivisoes.length, tempoTotal);
            
        } catch (error) {
            console.error(`❌ BACKGROUND: Erro crítico no processamento:`, error.message);
            
            // Enviar mensagem de erro
            try {
                await message.reply(`❌ *ERRO NO PROCESSAMENTO*\n\n${error.message}\n\n🔄 Tente novamente em alguns instantes.`);
            } catch (replyError) {
                console.error(`❌ BACKGROUND: Erro ao enviar mensagem de erro:`, replyError.message);
            }
        }
    }

    // === MENSAGEM FINAL DE CONCLUSÃO (NOVA FUNÇÃO) ===
    async enviarMensagemConclusao(message, sucessos, duplicados, erros, pedidosDuplicados, totalBlocos, tempoTotal) {
        try {
            let mensagemFinal = '';
            const tempoFormatado = tempoTotal > 10000 ? `${Math.round(tempoTotal/1000)}s` : `${tempoTotal}ms`;
            
            if (sucessos > 0 && duplicados === 0 && erros === 0) {
                // TODOS CRIADOS COM SUCESSO
                mensagemFinal = `🎉 *DIVISÃO CONCLUÍDA!*\n\n` +
                    `✅ **${sucessos}/${totalBlocos} pedidos criados**\n` +
                    `⚡ **Processado em ${tempoFormatado}**\n\n` +
                    `🚀 *O sistema principal processará as transferências automaticamente.*`;
                    
            } else if (sucessos === 0 && duplicados > 0 && erros === 0) {
                // TODOS JÁ EXISTIAM
                const statusPredominante = this.analisarStatusPredominante(pedidosDuplicados);
                
                if (statusPredominante === 'pendente') {
                    mensagemFinal = `⏳ *PEDIDOS JÁ EM PROCESSAMENTO*\n\n` +
                        `📋 **${duplicados} pedidos já estão no sistema**\n` +
                        `⚡ **Verificado em ${tempoFormatado}**\n\n` +
                        `🔄 *As transferências serão executadas automaticamente.*`;
                } else if (statusPredominante === 'processado') {
                    mensagemFinal = `✅ *DIVISÃO JÁ PROCESSADA*\n\n` +
                        `📋 **${duplicados} pedidos já foram executados**\n` +
                        `⚡ **Verificado em ${tempoFormatado}**\n\n` +
                        `🎯 *Transferências já foram concluídas anteriormente.*`;
                } else {
                    mensagemFinal = `📋 *PEDIDOS EXISTENTES*\n\n` +
                        `⚠️ **${duplicados} pedidos já estão no sistema**\n` +
                        `⚡ **Verificado em ${tempoFormatado}**\n\n` +
                        `🔍 *Verifique o status individual dos pedidos.*`;
                }
                    
            } else if (sucessos > 0 && (duplicados > 0 || erros > 0)) {
                // RESULTADO MISTO
                mensagemFinal = `⚠️ *PROCESSAMENTO CONCLUÍDO*\n\n` +
                    `✅ **${sucessos} pedidos criados**\n` +
                    (duplicados > 0 ? `📋 **${duplicados} já existiam**\n` : '') +
                    (erros > 0 ? `❌ **${erros} com erro**\n` : '') +
                    `⚡ **Processado em ${tempoFormatado}**\n\n` +
                    `📊 **Total:** ${sucessos + duplicados}/${totalBlocos} pedidos OK`;
                    
            } else if (erros > 0) {
                // SÓ ERROS
                mensagemFinal = `❌ *ERRO NO PROCESSAMENTO*\n\n` +
                    `🚫 **${erros}/${totalBlocos} pedidos falharam**\n` +
                    `⚡ **Tentativa em ${tempoFormatado}**\n\n` +
                    `🔄 *Tente novamente em alguns instantes.*`;
            }
            
            // ADICIONAR RODAPÉ DE VELOCIDADE
            if (tempoTotal < 30000) { // Menos de 30 segundos
                mensagemFinal += `\n\n🚀 *Processamento rápido ativado!*`;
            }
            
            await message.reply(mensagemFinal);
            console.log(`📤 BACKGROUND: Mensagem final enviada - ${sucessos}✅ ${duplicados}⚠️ ${erros}❌`);
            
        } catch (error) {
            console.error(`❌ BACKGROUND: Erro ao enviar mensagem final:`, error.message);
        }
    }
    
    // === ANALISAR STATUS PREDOMINANTE ===
    analisarStatusPredominante(pedidosDuplicados) {
        const statusCount = {};
        pedidosDuplicados.forEach(p => {
            const status = (p.status || 'existente').toLowerCase();
            statusCount[status] = (statusCount[status] || 0) + 1;
        });
        
        const statusMaisComum = Object.entries(statusCount)
            .sort(([,a], [,b]) => b - a)[0]?.[0] || 'existente';
        
        if (['pendente', 'aguardando', 'em processamento'].includes(statusMaisComum)) {
            return 'pendente';
        } else if (['processado', 'concluido', 'finalizado', 'executado'].includes(statusMaisComum)) {
            return 'processado';
        } else {
            return 'existente';
        }
    }
    
    // === SISTEMA DE FILA INTELIGENTE ===
    async adicionarNaFila(operacao, prioridade = 'normal') {
        return new Promise((resolve, reject) => {
            const item = {
                operacao,
                resolve,
                reject,
                prioridade,
                timestamp: Date.now()
            };
            
            // Inserir com base na prioridade
            if (prioridade === 'alta') {
                this.filaRequisicoes.unshift(item);
            } else {
                this.filaRequisicoes.push(item);
            }
            
            this.processarFila();
        });
    }
    
    async processarFila() {
        if (this.processandoFila || this.filaRequisicoes.length === 0) {
            return;
        }
        
        this.processandoFila = true;
        console.log(`🔄 DIVISÃO: Processando fila com ${this.filaRequisicoes.length} itens`);
        
        const processosAtivos = [];
        
        while (this.filaRequisicoes.length > 0 && processosAtivos.length < this.limiteConcorrencia) {
            const item = this.filaRequisicoes.shift();
            
            const processoAtivo = this.executarComEstatisticas(item);
            processosAtivos.push(processoAtivo);
            
            // Aguardar intervalo entre requisições para não sobrecarregar
            if (this.filaRequisicoes.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.intervaloEntreRequisicoes));
            }
        }
        
        // Aguardar todos os processos terminarem
        if (processosAtivos.length > 0) {
            await Promise.allSettled(processosAtivos);
        }
        
        this.processandoFila = false;
        
        // Se ainda há itens na fila, processar novamente
        if (this.filaRequisicoes.length > 0) {
            setTimeout(() => this.processarFila(), 100);
        }
    }
    
    async executarComEstatisticas(item) {
        const inicioTempo = Date.now();
        
        try {
            const resultado = await item.operacao();
            
            // Estatísticas de sucesso
            this.estatisticasRede.sucessos++;
            const tempoResposta = Date.now() - inicioTempo;
            this.estatisticasRede.tempoMedioResposta = 
                (this.estatisticasRede.tempoMedioResposta + tempoResposta) / 2;
            
            item.resolve(resultado);
            
        } catch (error) {
            // Estatísticas de falha
            this.estatisticasRede.falhas++;
            this.estatisticasRede.ultimaFalha = {
                timestamp: Date.now(),
                erro: error.message,
                tipo: this.classificarErro(error)
            };
            
            // Ajustar limites baseado em falhas
            this.ajustarLimitesPorFalhas(error);
            
            item.reject(error);
        }
    }
    
    classificarErro(error) {
        if (error.code === 'ECONNABORTED') return 'timeout';
        if (error.code === 'ENOTFOUND') return 'dns';
        if (error.code === 'ECONNREFUSED') return 'conexao';
        if (error.message && error.message.includes('500')) return 'servidor';
        return 'desconhecido';
    }
    
    ajustarLimitesPorFalhas(error) {
        const tipoErro = this.classificarErro(error);
        
        // Se muitas falhas de timeout/servidor, reduzir concorrência
        if (['timeout', 'servidor'].includes(tipoErro)) {
            this.limiteConcorrencia = Math.max(2, this.limiteConcorrencia - 1);
            this.intervaloEntreRequisicoes = Math.min(1000, this.intervaloEntreRequisicoes + 100);
            console.log(`⚠️ DIVISÃO: Reduzindo concorrência para ${this.limiteConcorrencia} e aumentando intervalo para ${this.intervaloEntreRequisicoes}ms`);
        }
        
        // Recuperar gradualmente após sucessos
        if (this.estatisticasRede.sucessos > 0 && this.estatisticasRede.sucessos % 5 === 0) {
            this.limiteConcorrencia = Math.min(5, this.limiteConcorrencia + 1);
            this.intervaloEntreRequisicoes = Math.max(200, this.intervaloEntreRequisicoes - 50);
        }
    }

    // === FUNÇÃO AUXILIAR: Retry com backoff exponencial OTIMIZADA ===
    async tentarComRetry(operacao, descricao, maxTentativas = 3) {
        // OTIMIZAÇÃO: Usar fila para controlar requisições
        return await this.adicionarNaFila(async () => {
            for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
                try {
                    // Timeout adaptativo baseado nas estatísticas de rede
                    const baseTimeout = Math.max(30000, this.estatisticasRede.tempoMedioResposta * 3);
                    const timeout = baseTimeout + (tentativa * 15000); // 30s, 45s, 60s (adaptativo)
                    
                    console.log(`🔄 DIVISÃO: ${descricao} - Tentativa ${tentativa}/${maxTentativas} (timeout: ${timeout}ms)`);
                    
                    return await operacao(timeout);
                    
                } catch (error) {
                    const isTimeout = error.code === 'ECONNABORTED' && error.message.includes('timeout');
                    const isUltimaTentativa = tentativa === maxTentativas;
                    
                    if (isTimeout && !isUltimaTentativa) {
                        const delayMs = tentativa * 1000 + Math.random() * 1000; // 1-2s, 2-3s (jitter)
                        console.log(`⏳ DIVISÃO: Timeout na tentativa ${tentativa}, aguardando ${Math.round(delayMs)}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        continue;
                    }
                    
                    console.error(`❌ DIVISÃO: ${descricao} falhou na tentativa ${tentativa}:`, error.message);
                    if (isUltimaTentativa) throw error;
                }
            }
        }, 'alta'); // Alta prioridade para tentativas de retry
    }

    // === ENVIAR PARA PLANILHA DE PEDIDOS ===
    async enviarParaPlanilhaPedidos(referencia, megas, numero, grupoId) {
        // VALIDAÇÃO: Garantir que referencia não é um número
        if (/^\d+$/.test(referencia)) {
            console.error(`❌ DIVISÃO: ERRO - Recebido número como referência: ${referencia}`);
            console.error(`❌ DIVISÃO: Isso é um bug! Referência deve ser alfanumérica, não só números.`);
            throw new Error(`Referência inválida: ${referencia} (deve ser alfanumérica)`);
        }
        
        console.log(`📋 DIVISÃO: Enviando pedido ${referencia}|${megas}|${numero}`);
        
        const timestamp = new Date().toLocaleString('pt-BR');
        const dadosCompletos = `${referencia}|${megas}|${numero}|${timestamp}`;
        
        const dados = {
            grupo_id: grupoId,
            timestamp: timestamp,
            dados: dadosCompletos,  // Para pedidos usar 'dados'
            sender: "WhatsApp-Bot-Divisao",
            message: `Pedido dividido: ${dadosCompletos}`
        };
        
        console.log(`📋 DIVISÃO: Dados:`, JSON.stringify(dados));
        
        return await this.tentarComRetry(
            async (timeout) => {
                const response = await axios.post(this.SCRIPTS_CONFIG.PEDIDOS, dados, {
                    timeout: timeout,
                    headers: { 'Content-Type': 'application/json' }
                });
                
                console.log(`📋 DIVISÃO: Resposta recebida:`, response.data);
                
                // Verificar se é pedido duplicado (caso especial)
                if (response.data && response.data.duplicado) {
                    console.log(`⚠️ DIVISÃO: Pedido ${referencia} já existe (Status: ${response.data.status_existente})`);
                    return { duplicado: true, referencia, status: response.data.status_existente };
                }
                
                if (!response.data || !response.data.success) {
                    const responseText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                    throw new Error(`Erro ao salvar pedido: ${responseText}`);
                }
                
                console.log(`✅ DIVISÃO: Pedido salvo com sucesso - ${referencia}|${megas}|${numero}`);
                return response.data;
            },
            `Envio de pedido ${referencia}`
        );
    }
    
    // === FUNÇÃO DE ENVIO DE PAGAMENTOS REMOVIDA ===
    // MOTIVO: O bot já consulta pagamentos na planilha para confirmar antes de enviar pedidos
    // Não é mais necessário enviar pagamentos duplicados para a planilha
    
    // === LIMPEZA DE DADOS ANTIGOS ===
    limparComprovantesAntigos() {
        const agora = Date.now();
        const timeout = 30 * 60 * 1000; // 30 minutos
        let removidos = 0;
        
        Object.keys(this.comprovantesMemorizados).forEach(remetente => {
            const comprovativo = this.comprovantesMemorizados[remetente];
            if (agora - comprovativo.timestamp > timeout) {
                delete this.comprovantesMemorizados[remetente];
                removidos++;
            }
        });
        
        if (removidos > 0) {
            console.log(`🗑️ DIVISÃO: ${removidos} comprovativos antigos removidos`);
        }
    }

    // === LIMPAR E NORMALIZAR NÚMERO ===
    limparNumero(numero) {
        if (!numero) return numero;
        
        // Remover caracteres especiais e espaços
        let numeroLimpo = numero.toString().replace(/\D/g, '');
        
        // Remover prefixo 258 se existir
        if (numeroLimpo.startsWith('258') && numeroLimpo.length > 9) {
            numeroLimpo = numeroLimpo.substring(3);
        }
        
        // Se após limpar sobrou um número que começa com 8 e tem 9 dígitos, retornar apenas os últimos 9
        if (/^8[0-9]{8,}$/.test(numeroLimpo) && numeroLimpo.length > 9) {
            numeroLimpo = numeroLimpo.slice(-9); // Pegar os últimos 9 dígitos
        }
        
        return numeroLimpo;
    }
    
    // === NORMALIZAR REMETENTE PARA ARMAZENAMENTO CONSISTENTE ===
    normalizarRemetente(remetente) {
        // Verificar se remetente é válido
        if (!remetente || typeof remetente !== 'string') {
            console.log(`⚠️ DIVISÃO: Remetente inválido para normalização: ${remetente}`);
            return 'remetente_indefinido';
        }
        
        // Extrair apenas os dígitos e pegar os últimos 9 (número de telefone)
        const numerosApenas = remetente.replace(/\D/g, '');
        if (numerosApenas.length >= 9) {
            return numerosApenas.slice(-9); // Retorna apenas os últimos 9 dígitos
        }
        return remetente; // Se não conseguir normalizar, retorna original
    }

    // === EXTRAIR ESPECIFICAÇÕES DO CLIENTE (APRIMORADA) ===
    extrairEspecificacoes(mensagem, numeros) {
        console.log(`🔍 DIVISÃO: Extraindo especificações da mensagem`);
        
        const especificacoes = {};
        const linhas = mensagem.split('\n').map(linha => linha.trim()).filter(linha => linha.length > 0);
        
        console.log(`   📄 Processando ${linhas.length} linhas da mensagem`);
        
        // Processar linha por linha para encontrar padrões
        for (let i = 0; i < linhas.length; i++) {
            const linha = linhas[i];
            console.log(`   🔍 Linha ${i + 1}: "${linha}"`);
            
            // Padrão 1: GB e número na mesma linha (ex: "10gb 852118624" ou "852118624 10gb")
            const sameLinha = linha.match(/(\d+)\s*gb\s+(\d{9})|((\d{9})\s+(\d+)\s*gb)/i);
            if (sameLinha) {
                const gb = parseInt(sameLinha[1] || sameLinha[5]);
                const numero = this.limparNumero(sameLinha[2] || sameLinha[4]);
                
                if (numeros.includes(numero) && !especificacoes[numero]) {
                    especificacoes[numero] = gb * 1024; // Converter GB para MB
                    console.log(`   ✅ Padrão mesma linha: ${numero} → ${gb}GB (${gb * 1024}MB)`);
                }
                continue;
            }
            
            // Padrão 2: Linha só com GB (ex: "10gb")
            const somenteGb = linha.match(/^(\d+)\s*gb\s*$/i);
            if (somenteGb) {
                const gb = parseInt(somenteGb[1]);
                console.log(`   🔍 GB detectado: ${gb}GB - procurando próximo número`);
                
                // Procurar o PRÓXIMO número que ainda não tem especificação
                for (let j = i + 1; j < linhas.length; j++) {
                    const linhaSeguinte = linhas[j];
                    const numeroMatch = linhaSeguinte.match(/(\d{9})/);
                    
                    if (numeroMatch) {
                        const numero = this.limparNumero(numeroMatch[1]);
                        if (numeros.includes(numero) && !especificacoes[numero]) {
                            especificacoes[numero] = gb * 1024;
                            console.log(`   ✅ Padrão separado: ${numero} → ${gb}GB (${gb * 1024}MB)`);
                            break;
                        }
                    }
                }
                continue;
            }
            
            // Padrão 3: Número seguido de GB (ex: "852118624 10gb")
            const numeroGb = linha.match(/(\d{9})\s+(\d+)\s*gb/i);
            if (numeroGb) {
                const numero = this.limparNumero(numeroGb[1]);
                const gb = parseInt(numeroGb[2]);
                
                if (numeros.includes(numero) && !especificacoes[numero]) {
                    especificacoes[numero] = gb * 1024;
                    console.log(`   ✅ Padrão número-gb: ${numero} → ${gb}GB (${gb * 1024}MB)`);
                }
                continue;
            }
            
            // Padrão 4: Formato com hífen ou dois pontos (ex: "852118624: 10gb" ou "852118624 - 10gb")
            const numeroSeparadorGb = linha.match(/(\d{9})\s*[:-]\s*(\d+)\s*gb/i);
            if (numeroSeparadorGb) {
                const numero = this.limparNumero(numeroSeparadorGb[1]);
                const gb = parseInt(numeroSeparadorGb[2]);
                
                if (numeros.includes(numero) && !especificacoes[numero]) {
                    especificacoes[numero] = gb * 1024;
                    console.log(`   ✅ Padrão separador: ${numero} → ${gb}GB (${gb * 1024}MB)`);
                }
                continue;
            }
        }
        
        console.log(`   📊 Especificações finais extraídas:`);
        Object.entries(especificacoes).forEach(([numero, megas]) => {
            console.log(`      • ${numero}: ${megas/1024}GB (${megas}MB)`);
        });
        
        return especificacoes;
    }
    
    // === VERIFICAÇÃO DE SAÚDE DO SISTEMA ===
    verificarSaudeDoSistema() {
        const agora = Date.now();
        const estatisticas = this.estatisticasRede;
        
        console.log(`🔍 DIVISÃO: Verificação de saúde do sistema`);
        console.log(`   📊 Sucessos: ${estatisticas.sucessos} | Falhas: ${estatisticas.falhas}`);
        console.log(`   ⏱️ Tempo médio: ${Math.round(estatisticas.tempoMedioResposta)}ms`);
        console.log(`   🔄 Fila: ${this.filaRequisicoes.length} itens | Concorrência: ${this.limiteConcorrencia}`);
        
        // Verificar se o sistema está com muitas falhas
        const totalRequests = estatisticas.sucessos + estatisticas.falhas;
        const taxaFalha = totalRequests > 0 ? (estatisticas.falhas / totalRequests) * 100 : 0;
        
        if (taxaFalha > 30) { // Mais de 30% de falhas
            console.log(`⚠️ DIVISÃO: Taxa de falha alta (${taxaFalha.toFixed(1)}%) - Aplicando correções`);
            this.aplicarCorrecoesSistema();
        }
        
        // Verificar se há itens muito antigos na fila
        const itensAntigos = this.filaRequisicoes.filter(item => 
            agora - item.timestamp > 10 * 60 * 1000 // 10 minutos
        );
        
        if (itensAntigos.length > 0) {
            console.log(`⚠️ DIVISÃO: ${itensAntigos.length} itens antigos na fila - Limpando`);
            this.filaRequisicoes = this.filaRequisicoes.filter(item => 
                agora - item.timestamp <= 10 * 60 * 1000
            );
        }
        
        // Verificar se o tempo de resposta está muito alto
        if (estatisticas.tempoMedioResposta > 30000) { // Mais de 30 segundos
            console.log(`⚠️ DIVISÃO: Tempo de resposta alto (${Math.round(estatisticas.tempoMedioResposta)}ms) - Ajustando`);
            this.limiteConcorrencia = Math.max(2, Math.floor(this.limiteConcorrencia / 2));
            this.intervaloEntreRequisicoes = Math.min(2000, this.intervaloEntreRequisicoes * 1.5);
        }
    }
    
    aplicarCorrecoesSistema() {
        // Reset estatísticas para começar fresh
        this.estatisticasRede.sucessos = 0;
        this.estatisticasRede.falhas = 0;
        this.estatisticasRede.tempoMedioResposta = 5000; // Valor conservador
        
        // Configurações mais conservadoras
        this.limiteConcorrencia = 2; // Reduzir para mínimo
        this.intervaloEntreRequisicoes = 1000; // 1 segundo entre requests
        
        // Limpar fila de itens com baixa prioridade
        this.filaRequisicoes = this.filaRequisicoes.filter(item => 
            item.prioridade === 'alta'
        );
        
        console.log(`🔧 DIVISÃO: Correções aplicadas - Concorrência: ${this.limiteConcorrencia}, Intervalo: ${this.intervaloEntreRequisicoes}ms`);
    }
    
    // === SISTEMA DE RECUPERAÇÃO DE PEDIDOS PERDIDOS ===
    async tentarRecuperarPedidoPerdido(referencia, dadosOriginais) {
        console.log(`🔄 DIVISÃO: Tentando recuperar pedido perdido ${referencia}`);
        
        try {
            // Verificar se o pedido realmente foi perdido
            const existeNaPlanilha = await this.buscarPagamentoNaPlanilha(referencia, dadosOriginais.valor);

            // Se já foi processado, também não precisa recuperar
            if (existeNaPlanilha === 'ja_processado') {
                console.log(`⚠️ DIVISÃO: Pedido ${referencia} já foi processado - Não é necessário recuperar`);
                return false;
            }

            if (!existeNaPlanilha) {
                console.log(`❌ DIVISÃO: Pedido ${referencia} realmente não existe - Não é necessário recuperar`);
                return false;
            }
            
            // Tentar recriar o pedido com prioridade alta
            await this.adicionarNaFila(async () => {
                console.log(`🚑 DIVISÃO: Recuperando pedido ${referencia}...`);
                await this.enviarParaPlanilhaPedidos(
                    dadosOriginais.referencia, 
                    dadosOriginais.megas, 
                    dadosOriginais.numero, 
                    dadosOriginais.grupoId
                );
            }, 'alta');
            
            console.log(`✅ DIVISÃO: Pedido ${referencia} recuperado com sucesso`);
            return true;
            
        } catch (error) {
            console.error(`❌ DIVISÃO: Erro na recuperação de ${referencia}:`, error.message);
            return false;
        }
    }

    // === STATUS DO BOT (MELHORADO) ===
    getStatus() {
        const taxaSucesso = this.estatisticasRede.sucessos + this.estatisticasRede.falhas > 0 ? 
            ((this.estatisticasRede.sucessos / (this.estatisticasRede.sucessos + this.estatisticasRede.falhas)) * 100).toFixed(1) : 100;
        
        return {
            comprovantesMemorizados: Object.keys(this.comprovantesMemorizados).length,
            processandoDivisoes: this.processandoDivisoes.size,
            gruposConfigurados: Object.keys(this.CONFIGURACAO_GRUPOS).length,
            // NOVAS ESTATÍSTICAS DE PERFORMANCE
            performance: {
                filaAtual: this.filaRequisicoes.length,
                concorrenciaAtiva: this.limiteConcorrencia,
                intervaloRequisicoes: this.intervaloEntreRequisicoes,
                taxaSucesso: `${taxaSucesso}%`,
                tempoMedioResposta: `${Math.round(this.estatisticasRede.tempoMedioResposta)}ms`,
                ultimaFalha: this.estatisticasRede.ultimaFalha?.timestamp ? 
                    new Date(this.estatisticasRede.ultimaFalha.timestamp).toLocaleString() : 'Nenhuma'
            }
        };
    }
}

module.exports = WhatsAppBotDivisao;