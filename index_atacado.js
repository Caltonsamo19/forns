require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const axios = require('axios'); // npm install axios

// === FILA DE REQUISIÇÕES PARA EVITAR RATE LIMITING ===
class FilaRequisicoes {
    constructor(maxConcorrentes = 3, delayEntreReqs = 500) {
        this.fila = [];
        this.emAndamento = 0;
        this.maxConcorrentes = maxConcorrentes; // Máximo de requisições simultâneas
        this.delayEntreReqs = delayEntreReqs;   // Delay entre cada requisição (500ms)
        this.ultimaRequisicao = 0;
    }

    async adicionar(funcao, nomeOperacao = "operação") {
        return new Promise((resolve, reject) => {
            this.fila.push({ funcao, nomeOperacao, resolve, reject });
            this.processar();
        });
    }

    async processar() {
        if (this.emAndamento >= this.maxConcorrentes || this.fila.length === 0) {
            return;
        }

        // Aguardar delay mínimo entre requisições
        const agora = Date.now();
        const tempoDesdeUltima = agora - this.ultimaRequisicao;
        if (tempoDesdeUltima < this.delayEntreReqs) {
            await new Promise(resolve => setTimeout(resolve, this.delayEntreReqs - tempoDesdeUltima));
        }

        const item = this.fila.shift();
        this.emAndamento++;
        this.ultimaRequisicao = Date.now();

        console.log(`📋 FILA: Processando "${item.nomeOperacao}" (${this.emAndamento}/${this.maxConcorrentes} em andamento, ${this.fila.length} na fila)`);

        try {
            const resultado = await item.funcao();
            item.resolve(resultado);
        } catch (error) {
            item.reject(error);
        } finally {
            this.emAndamento--;
            this.processar(); // Processar próximo item da fila
        }
    }

    obterStatus() {
        return {
            emAndamento: this.emAndamento,
            aguardando: this.fila.length,
            total: this.emAndamento + this.fila.length
        };
    }
}

// Instância global da fila
const filaRequisicoes = new FilaRequisicoes(3, 500); // 3 requisições simultâneas, 500ms entre cada

// === IMPORTAR A IA ATACADO ===
const WhatsAppAIAtacado = require('./whatsapp_ai_atacado');

// === IMPORTAR O BOT DE DIVISÃO ===
const WhatsAppBotDivisao = require('./whatsapp_bot_divisao');

// === CONFIGURAÇÃO GOOGLE SHEETS - BOT ATACADO (CONFIGURADA) ===
const GOOGLE_SHEETS_CONFIG_ATACADO = {
    scriptUrl: process.env.GOOGLE_SHEETS_SCRIPT_URL_ATACADO || 'https://script.google.com/macros/s/AKfycbzdvM-IrH4a6gS53WZ0J-AGXY0duHfgv15DyxdqUm1BLEm3Z15T67qgstu6yPTedgOSCA/exec',
    planilhaUrl: 'https://docs.google.com/spreadsheets/d/1ivc8gHD5WBWsvcwmK2dLBWpEHCI9J0C17Kog2NesuuE/edit',
    planilhaId: '1ivc8gHD5WBWsvcwmK2dLBWpEHCI9J0C17Kog2NesuuE',
    timeout: 60000,
    retryAttempts: 3,
    retryDelay: 2000
};

// === CONFIGURAÇÃO GOOGLE SHEETS - SALDO (NOVA) ===
const GOOGLE_SHEETS_CONFIG_SALDO = {
    scriptUrl: process.env.GOOGLE_SHEETS_SCRIPT_URL_SALDO || 'https://script.google.com/macros/s/AKfycby9UrgOSXkCnAKt4Csd3IPG6pr8i9jmgycrBy_cvsOT7x8eY0-EmJOmooSvw3eRuvF2tQ/exec',
    planilhaUrl: 'https://docs.google.com/spreadsheets/d/1fIE-bODZOF0oyUY-y5oUGL2g_LYzwoKdjdwc3bGo8hQ/edit',
    planilhaId: '1fIE-bODZOF0oyUY-y5oUGL2g_LYzwoKdjdwc3bGo8hQ',
    timeout: 60000,
    retryAttempts: 3,
    retryDelay: 2000
};

// === CONFIGURAÇÃO GOOGLE SHEETS - BOT RETALHO (mantida para compatibilidade) ===
const GOOGLE_SHEETS_CONFIG = {
    scriptUrl: process.env.GOOGLE_SHEETS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbz.../exec',
    timeout: 60000,
    retryAttempts: 3,
    retryDelay: 2000,
    planilhaId: process.env.GOOGLE_SHEETS_ID || '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
    nomePlanilha: 'Dados Retalho',
    colunas: {
        timestamp: 'A',
        referencia: 'B',
        valor: 'C',
        numero: 'D',
        grupo: 'E',
        autor: 'F',
        status: 'G'
    }
};

console.log(`📊 Google Sheets configurado: ${GOOGLE_SHEETS_CONFIG_ATACADO.scriptUrl}`);

// Criar instância do cliente
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "bot_atacado" // Diferente do bot retalho
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=TranslateUI',
            '--disable-ipc-flooding-protection'
        ],
        timeout: 60000
    }
});

// === INICIALIZAR A IA ===
require('dotenv').config();
const ia = new WhatsAppAIAtacado(process.env.OPENAI_API_KEY);

// === INICIALIZAR O BOT DE DIVISÃO ===
const botDivisao = new WhatsAppBotDivisao();

// REMOVIDO: ENCAMINHAMENTO_CONFIG, filaMensagens e processandoFila
// Sistema de backup via WhatsApp substituído por retry robusto com backoff exponencial

// === VARIÁVEIS PARA DADOS ===
let dadosParaTasker = [];

// Base de dados de compradores
let historicoCompradores = {};
const ARQUIVO_HISTORICO = 'historico_compradores_atacado.json';

// Cache de administradores dos grupos
let adminCache = {};

// Cache para evitar logs repetidos de grupos
let gruposLogados = new Set();

// Configuração de administradores GLOBAIS
const ADMINISTRADORES_GLOBAIS = [
    '258861645968@c.us',
    '258871112049@c.us',
    '258852118624@c.us',
    '258840326152@c.us'  // Adicionado para comandos administrativos
];

// === MAPEAMENTO DE NÚMEROS PARA GRUPOS ===
const MAPEAMENTO_NUMEROS_GRUPOS = {
    '258840326152': '120363419652375064@g.us',  // Net Fornecedor V
    '258852118624': '120363419652375064@g.us'   // Net Fornecedor V
};

// === CONFIGURAÇÃO DE MODERAÇÃO ===
const MODERACAO_CONFIG = {
    ativado: {
        '120363402160265624@g.us': true
    },
    detectarLinks: true,
    apagarMensagem: true,
    removerUsuario: false,
    excecoes: [
        '258861645968@c.us',
        '258871112049@c.us',
        '258852118624@c.us',
        '258840326152@c.us'
    ]
};

// === CONFIGURAÇÃO DOS GRUPOS PARA O BOT DE DIVISÃO ===
// Esta configuração deve estar sincronizada com CONFIGURACAO_GRUPOS
const CONFIGURACAO_GRUPOS_DIVISAO = {
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
        // === TABELA DE SALDO NET FORNECEDOR V ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        }
    },
    '120363402160265624@g.us': {
        nome: 'Treinamento IA',
        precos: {
            10240: 130,    // 10GB = 130MT
            20480: 260,    // 20GB = 260MT
            30720: 390,    // 30GB = 390MT
            40960: 520,    // 40GB = 520MT
            51200: 630,    // 50GB = 630MT
            61440: 750,    // 60GB = 750MT
            71680: 875,    // 70GB = 875MT
            81920: 1000    // 80GB = 1000MT
        },
        // === TABELA DE SALDO TREINAMENTO ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 90,     // 100MT saldo = 90MT pagamento
            200: 180,    // 200MT saldo = 180MT pagamento
            300: 270,    // 300MT saldo = 270MT pagamento
            500: 450,    // 500MT saldo = 450MT pagamento
            1000: 900    // 1000MT saldo = 900MT pagamento
        }
    },
    '120363422334163033@g.us': {
        nome: 'Data Store - Fornecedores',
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
        // === TABELA DE SALDO DATA STORE ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        }
    },
    '120363422552100928@g.us': {
        nome: 'Big Data Stock',
        precos: {
            10240: 125,    // 10GB = 125MT (12.5MT/GB)
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
        // === TABELA DE SALDO BIG DATA STOCK ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        }
    },
    '120363304379117798@g.us': {
        nome: 'Shop Net Revendedores',
        precos: {
            10240: 128,    // 10GB = 128MT (12.8MT/GB)
            20480: 256,    // 20GB = 256MT
            30720: 384,    // 30GB = 384MT
            40960: 512,    // 40GB = 512MT
            51200: 640,    // 50GB = 640MT
            61440: 768,    // 60GB = 768MT
            71680: 910,    // 70GB = 910MT
            81920: 1040,   // 80GB = 1040MT
            92160: 1170,   // 90GB = 1170MT
            102400: 1280   // 100GB = 1280MT
        },
        // === TABELA DE SALDO SHOP NET REVENDEDORES ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 820,   // 1000MT saldo = 820MT pagamento
            2000: 1640,  // 2000MT saldo = 1640MT pagamento
            3000: 2460,  // 3000MT saldo = 2460MT pagamento
            4000: 3270,  // 4000MT saldo = 3270MT pagamento
            5000: 4100,  // 5000MT saldo = 4100MT pagamento
            6000: 4900   // 6000MT saldo = 4900MT pagamento
        }
    },
    '120363390556636836@g.us': {
        nome: 'Net Vodacom Para Revendedores',
        precos: {
            10240: 130,    // 10GB = 130MT (13MT/GB)
            20480: 260,    // 20GB = 260MT
            30720: 390,    // 30GB = 390MT
            40960: 520,    // 40GB = 520MT
            51200: 650,    // 50GB = 650MT
            61440: 768,    // 60GB = 768MT (12.8MT/GB VIP)
            71680: 896,    // 70GB = 896MT
            81920: 1024,   // 80GB = 1024MT
            92160: 1152,   // 90GB = 1152MT
            103424: 1280   // 101GB = 1280MT
        },
        // === TABELA DE SALDO NET VODACOM PARA REVENDEDORES ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        }
    }
    // Only Saldo foi removido pois não precisa de divisão automática
};

// Atualizar a configuração do bot de divisão
botDivisao.CONFIGURACAO_GRUPOS = CONFIGURACAO_GRUPOS_DIVISAO;

// Configuração para cada grupo (ATACADO)
const CONFIGURACAO_GRUPOS = {
    '120363419652375064@g.us': {
        nome: 'Net Fornecedor V',
        // CORREÇÃO: Adicionar preços estruturados para cálculo correto de megas
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
        // === TABELA DE SALDO NET FORNECEDOR V ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        },
        tabela: `GB'S COMPLETOS
📱 10GB➜125MT 
📱 20GB ➜ 250MT  
📱 30GB ➜ 375MT  
📱 40GB ➜ 500MT  
📱 50GB ➜ 625MT  
📱 60GB ➜ 750MT  
📱 70GB ➜ 875MT  
📱 80GB ➜ 1000MT  
📱 90GB ➜ 1125MT  
📱 100GB➜1250MT

📞 1 Comprovante = 1 Número = Valor Completo`,

        pagamento: `FORMAS DE PAGAMENTO

M-PESA❤: 840326152
E-MOLA🧡: 870059057
NOME: Vasco José Mahumane

📝 Após a transferência, mande:
1️⃣ Comprovativo
2️⃣ UM número que vai receber`,

        saldo: `SALDO PROMO 1K🟰815📞
    
 📞 50      💫 45     MT
 📞 100    💫 85     MT
📞 200     💫 170   MT
📞 300     💫 255   MT
📞 400     💫 340   MT
📞 500     💫 410   MT 
📞 1000   💫 815   MT
📞 2000   💫 1630 MT
📞 3000   💫 2445 MT
📞 4000   💫 3260 MT
📞 5000   💫 4075 MT
📞 6000   💫 4890 MT
📞 7000   💫 5705 MT
📞 8000   💫 6520 MT
📞 9000   💫 7335 MT
📞 10000 💫 8150 MT

📩 Após o envio do valor, mande o compravativo no grupo e o respectivo número beneficiário.`
    },
    '120363419741642342@g.us': {
        nome: 'Only Saldo',
        tabela: `SALDO PROMO 1K🟰815📞
    
 📞 50      💫 45     MT
 📞 100    💫 85     MT
📞 200     💫 170   MT
📞 300     💫 255   MT
📞 400     💫 340   MT
📞 500     💫 410   MT 
📞 1000   💫 815   MT
📞 2000   💫 1630 MT
📞 3000   💫 2445 MT
📞 4000   💫 3260 MT
📞 5000   💫 4075 MT
📞 6000   💫 4890 MT
📞 7000   💫 5705 MT
📞 8000   💫 6520 MT
📞 9000   💫 7335 MT
📞 10000 💫 8150 MT

📩 Após o envio do valor, mande o compravativo no grupo e o respectivo número beneficiário.`,

        pagamento: `FORMAS DE PAGAMENTO

M-PESA❤: 840326152
E-MOLA🧡: 870059057
NOME: Vasco José Mahumane

📝 Após a transferência, mande:
1️⃣ Comprovativo
2️⃣ UM número que vai receber`,

        saldo: `📱 TABELA DE SALDO - ONLY SALDO 📱

💰 50MT saldo = 45MT pagamento
💰 100MT saldo = 85MT pagamento
💰 200MT saldo = 170MT pagamento
💰 300MT saldo = 255MT pagamento
💰 400MT saldo = 340MT pagamento
💰 500MT saldo = 410MT pagamento
💰 1000MT saldo = 815MT pagamento
💰 2000MT saldo = 1630MT pagamento
💰 3000MT saldo = 2445MT pagamento
💰 4000MT saldo = 3260MT pagamento
💰 5000MT saldo = 4075MT pagamento
💰 6000MT saldo = 4890MT pagamento
💰 7000MT saldo = 5705MT pagamento
💰 8000MT saldo = 6520MT pagamento
💰 9000MT saldo = 7335MT pagamento
💰 10000MT saldo = 8150MT pagamento`
    },
    '120363402160265624@g.us': {
        nome: 'Treinamento IA',
        precos: {
            10240: 130,    // 10GB = 130MT
            20480: 260,    // 20GB = 260MT
            30720: 390,    // 30GB = 390MT
            40960: 520,    // 40GB = 520MT
            51200: 630,    // 50GB = 630MT
            61440: 750,    // 60GB = 750MT
            71680: 875,    // 70GB = 875MT
            81920: 1000    // 80GB = 1000MT
        },
        // === TABELA DE SALDO TREINAMENTO ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 90,     // 100MT saldo = 90MT pagamento
            200: 180,    // 200MT saldo = 180MT pagamento
            300: 270,    // 300MT saldo = 270MT pagamento
            500: 450,    // 500MT saldo = 450MT pagamento
            1000: 900    // 1000MT saldo = 900MT pagamento
        },
        tabela: `🚨PROMOÇÃO DE GIGABYTES🚨
MAIS DE 40 GIGABYTES 12.5
Oferecemos-lhe serviços extremamente rápido e seguro.🥳
🛜📶 TABELA NORMAL🌐
♨ GB's🛜 COMPLETOS🔥
🌐 10GB  🔰   130MT💳
🌐 20GB  🔰   260MT💳
🌐 30GB  🔰   390MT💳
🌐 40GB  🔰   520MT💳

PACOTE VIP 12.5 24H
🌐 50GB  🔰   630MT💳
🌐 60GB  🔰   750MT💳
🌐 70GB  🔰   875MT💳
🌐 80GB  🔰 1000MT💳

SINTAM-SE AVONTADE, EXPLOREM-NOS ENQUANTO PUDEREM!`,

        pagamento: `FORMAS DE PAGAMENTO

M-PESA❤: 840326152
E-MOLA🧡: 870059057
NOME: Vasco José Mahumane

📝 Após a transferência, mande:
1️⃣ Comprovativo
2️⃣ UM número que vai receber`,

        saldo: `📱 TABELA DE SALDO - TREINAMENTO IA 📱

💰 50MT saldo = 45MT pagamento
💰 100MT saldo = 90MT pagamento
💰 200MT saldo = 180MT pagamento
💰 300MT saldo = 270MT pagamento
💰 500MT saldo = 450MT pagamento
💰 1000MT saldo = 900MT pagamento`
    },
    '120363422334163033@g.us': {
        nome: 'Data Store - Fornecedores',
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
        // === TABELA DE SALDO DATA STORE ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        },
        tabela: `🚨📢🔥 PROMOÇÃO GIGABYTES COMPLETOS 🔥📢🚨
📅 Outubro 2025
✅ Apenas para clientes Vodacom

🛜 10GB = 125MT 💰
🛜 20GB = 250MT 💰
🛜 30GB = 375MT 💰
🛜 40GB = 500MT 💰
🛜 50GB = 625MT 💰
🛜 60GB = 750MT 💰
🛜 70GB = 875MT 💰
🛜 80GB = 1000MT 💰
🛜 90GB = 1125MT 💰
🛜 100GB = 1250MT 💰

⚡ Aproveita já e garante o teu pacote antes do fim da promoção! ⚡`,

        pagamento: `✅FORMAS DE PAGAMENTO ATUALIZADAS

💡M-PESA
NÚMERO: 848715208
NOME: NATACHA ALICE

💡eMola
NÚMERO: 871112049
NOME: NATACHA ALICE

📝 Após a transferência, mande:
1️⃣ Comprovativo
2️⃣ UM número que vai receber`,

        saldo: `🚨✅🔥 SALDO PROMO🔥✅🚨
✅1000 Saldo  = 815MT
📅 Outubro 2025

📶 50   = 45MT 💰
📶 100  = 85MT 💰
📶 200  = 170MT 💰
📶 300  = 255MT 💰
📶 400  = 340MT 💰
📶 500  = 410MT 💰
📶 1000 = 815MT 💰
📶 2000 = 1630MT 💰
📶 3000 = 2445MT 💰
📶 4000 = 3260MT 💰
📶 5000 = 4075MT 💰
📶 6000 = 4890MT 💰
📶 7000 = 5705MT 💰
📶 8000 = 6520MT 💰
📶 9000 = 7335MT 💰
📶 10000 = 8150MT 💰

📩 Após o envio do valor, envie o comprovativo no grupo
e o respetivo número beneficiário.

⚡ Aproveitem! ⚡`
    },
    '120363422552100928@g.us': {
        nome: 'Big Data Stock',
        precos: {
            10240: 125,    // 10GB = 125MT (12.5MT/GB)
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
        // === TABELA DE SALDO BIG DATA STOCK ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        },
        tabela: `💥 MEGABYTESx & ☎️ CRÉDITOS 🚨
🛜 Tudo a preços acessíveis!
💲 Ofertas exclusivas para revendedores 👌

GB's COMPLETOS 🟰 12 🔥

🌐 10GB — 💳 125MT
🌐 20GB — 💳 250MT
🌐 30GB — 💳 375MT
🌐 40GB — 💳 500MT
🌐 50GB — 💳 625MT
🌐 60GB — 💳 750MT
🌐 70GB — 💳 875MT
🌐 80GB — 💳 1000MT
🌐 90GB — 💳 1125MT
🌐 100GB — 💳 1250MT

📞 1 Comprovante = 1 Número = Valor Completo`,

        pagamento: `💸 FORMAS DE PAGAMENTO

🔴 M-Pesa – Leonor | 📲 857451196

⚠ ATENÇÃO
▪ Após o pagamento, envie a confirmação ✉ e o seu número para receber o seu pacote 📲
▪ Envie o valor exato da tabela 💰

NB: Válido apenas para Vodacom
🚀 Garanta seus Megabytes agora!`,

        saldo: `🚨✅🔥 SALDO PROMO🔥✅🚨
✅1000 Saldo  = 815MT
📅 Outubro 2025

📶 50   = 45MT 💰
📶 100  = 85MT 💰
📶 200  = 170MT 💰
📶 300  = 255MT 💰
📶 400  = 340MT 💰
📶 500  = 410MT 💰
📶 1000 = 815MT 💰
📶 2000 = 1630MT 💰
📶 3000 = 2445MT 💰
📶 4000 = 3260MT 💰
📶 5000 = 4075MT 💰
📶 6000 = 4890MT 💰
📶 7000 = 5705MT 💰
📶 8000 = 6520MT 💰
📶 9000 = 7335MT 💰
📶 10000 = 8150MT 💰

📩 Após o envio do valor, envie o comprovativo no grupo
e o respetivo número beneficiário.

⚡ Aproveitem! ⚡`
    },
    '120363304379117798@g.us': {
        nome: 'Shop Net Revendedores',
        precos: {
            10240: 128,    // 10GB = 128MT (12.8MT/GB)
            20480: 256,    // 20GB = 256MT
            30720: 384,    // 30GB = 384MT
            40960: 512,    // 40GB = 512MT
            51200: 640,    // 50GB = 640MT
            61440: 768,    // 60GB = 768MT
            71680: 910,    // 70GB = 910MT
            81920: 1040,   // 80GB = 1040MT
            92160: 1170,   // 90GB = 1170MT
            102400: 1280   // 100GB = 1280MT
        },
        // === TABELA DE SALDO SHOP NET REVENDEDORES ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 820,   // 1000MT saldo = 820MT pagamento
            2000: 1640,  // 2000MT saldo = 1640MT pagamento
            3000: 2460,  // 3000MT saldo = 2460MT pagamento
            4000: 3270,  // 4000MT saldo = 3270MT pagamento
            5000: 4100,  // 5000MT saldo = 4100MT pagamento
            6000: 4900   // 6000MT saldo = 4900MT pagamento
        },
        tabela: `🛜 PROMOÇÃO Relâmpago 12.8MT
*DE MEGABYTES & ☎️CRÉDITOS📞 EXCLUSIVO PARA REVENDEDORES*

🌐 PACOTES DE INTERNET
🔹 10GB ➡️ 128MT
🔹 20GB ➡️ 256MT
🔹 30GB ➡️ 384MT
🔹 40GB ➡️ 512MT
🔹 50GB ➡️ 640MT
🔹 60GB ➡️ 768MT
🔹 70GB ➡️ 910MT
🔹 80GB ➡️ 1040MT
🔹 90GB ➡️ 1170MT
🔹 100GB ➡️ 1280MT

🎯 *12,8MT por GB*
📞 1 Comprovante = 1 Número = Valor Completo`,

        pagamento: `💳 *FORMAS DE PAGAMENTO:*⤵️  
- 📲 *𝗘-𝗠𝗢𝗟𝗔: *872685743💶💰  
- *Almeida Vasco* 
- 📲 *𝗠-𝗣𝗘𝗦𝗔: 851923280💷💰  
- ↪️📞📱 *Almeida*  

📩 *Envie o seu comprovante no grupo, juntamente com o número que receberá os dados.*`,

        saldo: `*Saldo Vodacom*
*O Pagamento de saldo Deve ser feito via M pesa*

📶 50   = 45MT 💰
📶 100  = 85MT 💰
📶 200  = 170MT 💰
📶 300  = 255MT 💰
📶 400  = 340MT 💰
📶 500  = 410MT 💰
📶 1000 = 820MT 💰
📶 2000 = 1640MT 💰
📶 3000 = 2460MT 💰
📶 4000 = 3270MT 💰
📶 5000 = 4100MT 💰
📶 6000 = 4900MT 💰

✅ Após pagar, envie:
1️⃣ O comprovativo
2️⃣ O número que vai receber Saldo`
    },
    '120363390556636836@g.us': {
        nome: 'Net Vodacom Para Revendedores',
        precos: {
            10240: 130,    // 10GB = 130MT (13MT/GB)
            20480: 260,    // 20GB = 260MT
            30720: 390,    // 30GB = 390MT
            40960: 520,    // 40GB = 520MT
            51200: 650,    // 50GB = 650MT
            61440: 768,    // 60GB = 768MT (12.8MT/GB VIP)
            71680: 896,    // 70GB = 896MT
            81920: 1024,   // 80GB = 1024MT
            92160: 1152,   // 90GB = 1152MT
            103424: 1280   // 101GB = 1280MT
        },
        // === TABELA DE SALDO NET VODACOM PARA REVENDEDORES ===
        precosSaldo: {
            50: 45,      // 50MT saldo = 45MT pagamento
            100: 85,     // 100MT saldo = 85MT pagamento
            200: 170,    // 200MT saldo = 170MT pagamento
            300: 255,    // 300MT saldo = 255MT pagamento
            400: 340,    // 400MT saldo = 340MT pagamento
            500: 410,    // 500MT saldo = 410MT pagamento
            1000: 815,   // 1000MT saldo = 815MT pagamento
            2000: 1630,  // 2000MT saldo = 1630MT pagamento
            3000: 2445,  // 3000MT saldo = 2445MT pagamento
            4000: 3260,  // 4000MT saldo = 3260MT pagamento
            5000: 4075,  // 5000MT saldo = 4075MT pagamento
            6000: 4890,  // 6000MT saldo = 4890MT pagamento
            7000: 5705,  // 7000MT saldo = 5705MT pagamento
            8000: 6520,  // 8000MT saldo = 6520MT pagamento
            9000: 7335,  // 9000MT saldo = 7335MT pagamento
            10000: 8150  // 10000MT saldo = 8150MT pagamento
        },
        tabela: `☎️💰 *NET VODACOM PARA REVENDEDORES*🔥🤑📲💸

*10GB     💳   130MT💸*
*20GB     💳   260MT💸*
*30GB     💳   390MT💸*
*40GB     💳   520MT💸*
*50GB     💳   650MT💸*

💰 *PACOTE VIP 12.8🪙*💰
*60GB        💳     768MT💸*
*70GB        💳     896MT💸*
*80GB        💳   1024MT💸*
*90GB        💳   1152MT💸*
*101GB      💳   1280MT💸*`,

        pagamento: `💰 *FORMAS/ PAGAMENTOS :*
- 💵 *𝗘-𝗠𝗢𝗟𝗔: 865147776 💎 ANTÓNIO F. ZUCULA*
- 💵 *𝗠-𝗣𝗘𝗦𝗔: 849430041 💎 ANTÓNIO ZUCULA*
- 💵 *MBIM:  1234483208  💎 ANTÓNIO F. ZUCULA*

*Call, sms & WhatsApp* *849430041 / 865147776*

*NB:DEPOIS DE ENVIAR O VALOR, ENVIE O COMPROVANTE E O NR PARA RECEBER OS MEGAS NO GRUPO OU NO MEU PRIVADO*`,

        saldo: `📦 PACOTES DE SALDO

⚡ 50 Saldo ───  45 MT
⚡ 100 Saldo ─── 85 MT
⚡ 200 Saldo ─── 170 MT
⚡ 300 Saldo ─── 255 MT
⚡ 400 Saldo ─── 340 MT
⚡ 500 Saldo ─── 410 MT
⚡ 1000 Saldo ── 815 MT
⚡ 2000 Saldo ───1.630 MT
⚡ 3000 Saldo ───2.445 MT
⚡ 4000 Saldo ── 3.260 MT
⚡ 5000 Saldo ── 4.075 MT
⚡ 6000 Saldo ── 4.890 MT
⚡ 7000 Saldo ── 5.705 MT
⚡ 8000 Saldo ── 6.520 MT
⚡ 9000 Saldo ── 7.335 MT
⚡ 10000 Saldo ─ 8.150 MT
📝 *Escolha o pacote e envie o comprovativo*`
    }
};

// === FUNÇÃO GOOGLE SHEETS ===

// Função para retry automático com backoff exponencial
async function tentarComRetry(funcao, maxTentativas = 5, delayInicial = 2000) {
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            return await funcao();
        } catch (error) {
            console.log(`⚠️ Tentativa ${tentativa}/${maxTentativas} falhou: ${error.message}`);

            if (tentativa === maxTentativas) {
                console.error(`❌ ERRO CRÍTICO: Todas as ${maxTentativas} tentativas falharam!`);
                throw error; // Última tentativa, propagar erro
            }

            // Backoff exponencial: 2s, 4s, 8s, 16s, 32s
            const delay = delayInicial * Math.pow(2, tentativa - 1);
            console.log(`⏳ Aguardando ${delay}ms antes da próxima tentativa...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// === FUNÇÃO GOOGLE SHEETS PARA SALDO ===
async function enviarSaldoParaGoogleSheets(dadosCompletos, grupoId, timestamp) {
    const dados = {
        grupo_id: grupoId,
        timestamp: timestamp,
        dados: dadosCompletos,
        tipo: 'saldo'
    };

    try {
        console.log(`📊 SALDO: Enviando para Google Sheets...`);

        const resultado = await tentarComRetry(async () => {
            const response = await axios.post(GOOGLE_SHEETS_CONFIG_SALDO.scriptUrl, dados, {
                timeout: GOOGLE_SHEETS_CONFIG_SALDO.timeout,
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        }, GOOGLE_SHEETS_CONFIG_SALDO.retryAttempts, GOOGLE_SHEETS_CONFIG_SALDO.retryDelay);

        console.log(`✅ SALDO: Dados enviados para Google Sheets:`, resultado);
        return { sucesso: true, dados: resultado };

    } catch (error) {
        console.error(`❌ SALDO: Erro ao enviar para Google Sheets:`, error.message);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO GOOGLE SHEETS SIMPLIFICADA COM RETRY ROBUSTO ===
async function enviarParaGoogleSheets(dadosCompletos, grupoId, timestamp) {
    const dados = {
        grupo_id: grupoId,
        timestamp: timestamp,
        dados: dadosCompletos  // REF|MEGAS|NUMERO|TIMESTAMP como string única
    };

    console.log(`📊 Enviando para Google Sheets com RETRY ROBUSTO: ${dadosCompletos}`);
    console.log(`📍 Grupo: ${grupoId}`);
    console.log(`⏰ Timestamp: ${timestamp}`);

    try {
        // Usar retry com backoff exponencial (5 tentativas: 2s, 4s, 8s, 16s, 32s)
        const resultado = await tentarComRetry(async () => {
            const response = await axios.post(GOOGLE_SHEETS_CONFIG_ATACADO.scriptUrl, dados, {
                timeout: GOOGLE_SHEETS_CONFIG_ATACADO.timeout,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bot-Source': 'WhatsApp-Bot-Atacado-Simplificado'
                },
                validateStatus: function (status) {
                    return status < 500;
                }
            });

            // Log detalhado da resposta para debug
            console.log(`🔍 DEBUG Google Sheets Response:`, {
                status: response.status,
                statusText: response.statusText,
                data: response.data,
                dataType: typeof response.data,
                hasSuccess: response.data?.success,
                hasError: response.data?.error
            });

            if (response.data && response.data.success) {
                console.log(`✅ Google Sheets: Dados enviados! Row: ${response.data.row}`);
                console.log(`📋 Dados inseridos: ${response.data.dados}`);
                return { sucesso: true, row: response.data.row };
            } else if (response.data && response.data.duplicado) {
                // Caso especial: Pagamento duplicado (não deve fazer retry)
                console.log(`⚠️ Google Sheets: Pagamento duplicado - ${response.data.referencia}`);
                return {
                    sucesso: false,
                    duplicado: true,
                    referencia: response.data.referencia,
                    erro: `Pagamento duplicado: ${response.data.referencia}`
                };
            } else {
                const errorMsg = response.data?.error || `Resposta inválida: ${JSON.stringify(response.data)}`;
                throw new Error(errorMsg);
            }
        }, 5, 2000); // 5 tentativas com delay inicial de 2s

        return resultado;
        
    } catch (error) {
        console.error(`❌ Erro Google Sheets: ${error.message}`);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO PARA NORMALIZAR VALORES (remove vírgulas e converte) ===
function normalizarValor(valor) {
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
            console.warn(`⚠️ Valor não pôde ser normalizado: "${valor}"`);
            return valor;
        }
        
        // Retorna inteiro se não tem decimais significativos
        return (Math.abs(valorNumerico % 1) < 0.0001) ? Math.round(valorNumerico) : valorNumerico;
    }
    
    return valor;
}

// === FUNÇÃO DE RETRY COM EXPONENTIAL BACKOFF E FILA ===
async function retryComBackoff(funcao, maxTentativas = 3, nomeOperacao = "operação") {
    let tentativa = 0;
    let delayBase = 1000; // 1 segundo inicial

    while (tentativa < maxTentativas) {
        try {
            tentativa++;
            console.log(`🔄 ${nomeOperacao}: Tentativa ${tentativa}/${maxTentativas}`);

            // Adicionar à fila para controlar rate limiting
            const resultado = await filaRequisicoes.adicionar(funcao, nomeOperacao);
            console.log(`✅ ${nomeOperacao}: Sucesso na tentativa ${tentativa}`);
            return resultado;

        } catch (error) {
            const isUltimaTentativa = tentativa >= maxTentativas;
            const statusCode = error.response?.status;
            const errorMsg = error.message;

            // Tratamento específico para erro 429 (Rate Limit)
            if (statusCode === 429) {
                const retryAfter = error.response?.headers['retry-after'];
                const delayParaEsperar = retryAfter ? parseInt(retryAfter) * 1000 : delayBase * Math.pow(2, tentativa);

                if (!isUltimaTentativa) {
                    console.warn(`⚠️ ${nomeOperacao}: Rate limit (429) - aguardando ${delayParaEsperar}ms antes de tentar novamente...`);
                    await new Promise(resolve => setTimeout(resolve, delayParaEsperar));
                    continue;
                } else {
                    console.error(`❌ ${nomeOperacao}: Rate limit (429) - máximo de tentativas atingido`);
                    throw error;
                }
            }

            // Tratamento para timeout
            if (errorMsg.includes('timeout')) {
                if (!isUltimaTentativa) {
                    const delayTimeout = delayBase * Math.pow(2, tentativa);
                    console.warn(`⚠️ ${nomeOperacao}: Timeout - aguardando ${delayTimeout}ms antes de tentar novamente...`);
                    await new Promise(resolve => setTimeout(resolve, delayTimeout));
                    continue;
                } else {
                    console.error(`❌ ${nomeOperacao}: Timeout - máximo de tentativas atingido`);
                    throw error;
                }
            }

            // Outros erros de rede (ECONNREFUSED, ENOTFOUND, etc)
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
                if (!isUltimaTentativa) {
                    const delayRede = delayBase * Math.pow(2, tentativa);
                    console.warn(`⚠️ ${nomeOperacao}: Erro de rede (${error.code}) - aguardando ${delayRede}ms antes de tentar novamente...`);
                    await new Promise(resolve => setTimeout(resolve, delayRede));
                    continue;
                } else {
                    console.error(`❌ ${nomeOperacao}: Erro de rede (${error.code}) - máximo de tentativas atingido`);
                    throw error;
                }
            }

            // Para outros erros, não faz retry
            console.error(`❌ ${nomeOperacao}: Erro não recuperável:`, errorMsg);
            throw error;
        }
    }
}

// === FUNÇÃO PARA VERIFICAR PAGAMENTO (reutiliza mesma lógica da divisão) ===
async function verificarPagamentoIndividual(referencia, valorEsperado) {
    try {
        // Normalizar valor antes da verificação
        const valorNormalizado = normalizarValor(valorEsperado);

        console.log(`🔍 INDIVIDUAL: Verificando pagamento ${referencia} - ${valorNormalizado}MT (original: ${valorEsperado})`);

        // Usar retry com backoff para chamada HTTP
        const response = await retryComBackoff(
            async () => {
                return await axios.post(botDivisao.SCRIPTS_CONFIG.PAGAMENTOS, {
                    action: "buscar_por_referencia",
                    referencia: referencia,
                    valor: valorNormalizado
                }, {
                    timeout: 120000, // Aumentado de 60s para 120s
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
            },
            3, // 3 tentativas
            `Verificar pagamento ${referencia}`
        );

        if (response.data && response.data.encontrado) {
            // VERIFICAR SE PAGAMENTO JÁ FOI PROCESSADO
            if (response.data.ja_processado) {
                console.log(`⚠️ INDIVIDUAL: Pagamento já foi processado anteriormente!`);
                return 'ja_processado';
            }

            console.log(`✅ INDIVIDUAL: Pagamento encontrado (ainda não marcado como processado)!`);
            return true;
        }

        console.log(`❌ INDIVIDUAL: Pagamento não encontrado`);
        return false;

    } catch (error) {
        console.error(`❌ INDIVIDUAL: Erro ao verificar pagamento:`, error.message);
        return false;
    }
}

// === FUNÇÃO PARA MARCAR PAGAMENTO COMO PROCESSADO ===
async function marcarPagamentoComoProcessado(referencia, valorEsperado) {
    try {
        const valorNormalizado = normalizarValor(valorEsperado);
        console.log(`✅ INDIVIDUAL: Marcando pagamento ${referencia} como processado`);

        // Usar retry com backoff para chamada HTTP
        const response = await retryComBackoff(
            async () => {
                return await axios.post(botDivisao.SCRIPTS_CONFIG.PAGAMENTOS, {
                    action: "marcar_processado",
                    referencia: referencia,
                    valor: valorNormalizado
                }, {
                    timeout: 120000, // Aumentado de 60s para 120s
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
            },
            3, // 3 tentativas
            `Marcar pagamento ${referencia} como processado`
        );

        if (response.data && response.data.success) {
            console.log(`✅ INDIVIDUAL: Pagamento marcado como processado com sucesso!`);
            return true;
        }

        console.log(`⚠️ INDIVIDUAL: Falha ao marcar pagamento como processado`);
        return false;

    } catch (error) {
        console.error(`❌ INDIVIDUAL: Erro ao marcar pagamento como processado:`, error.message);
        return false;
    }
}

// === FUNÇÃO DE RETRY AUTOMÁTICO PARA PAGAMENTOS ===
async function tentarPagamentoComRetryAutomatico(referencia, valorEsperado, dadosCompletos, message) {
    const INTERVALO_RETRY = 15000; // 15 segundos
    const DURACAO_TOTAL = 2 * 60 * 1000; // 2 minutos
    const TENTATIVAS_MAX = Math.floor(DURACAO_TOTAL / INTERVALO_RETRY); // 8 tentativas

    console.log(`🔄 RETRY: Iniciando retry automático para ${referencia} - ${TENTATIVAS_MAX} tentativas a cada 15s por 2min`);

    // Extrair dados do objeto dadosCompletos
    const { isSaldo, produtoConvertido, produto, numero, valorNormalizado, tipoProdutoTexto, produtoTexto } = dadosCompletos;

    let tentativa = 1;

    const intervalId = setInterval(async () => {
        try {
            console.log(`🔄 RETRY: Tentativa ${tentativa}/${TENTATIVAS_MAX} - Verificando pagamento ${referencia}`);

            const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorEsperado);

            if (pagamentoConfirmado === 'ja_processado') {
                console.log(`✅ RETRY: Pagamento já processado encontrado na tentativa ${tentativa}!`);
                clearInterval(intervalId);

                await message.reply(
                    `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                    `💵 Valor: ${valorNormalizado}MT\n\n` +
                    `✅ Este pagamento já foi processado anteriormente. Não é necessário enviar novamente.\n\n` +
                    `Se você acredita que isso é um erro, entre em contato com o suporte.`
                );
                return;
            }

            if (pagamentoConfirmado) {
                console.log(`✅ RETRY: Pagamento confirmado na tentativa ${tentativa}! Processando...`);
                clearInterval(intervalId);

                // Notificar sucesso
                await message.reply(
                    `✅ *PAGAMENTO ENCONTRADO!*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                    `📱 Número: ${numero}\n` +
                    `💵 Valor: ${valorNormalizado}MT\n\n` +
                    `🚀 Processando seu pedido...`
                );

                // Processar o pedido
                if (isSaldo) {
                    await enviarSaldoParaTasker(referencia, produtoConvertido, numero, message.from, message);
                    await registrarComprador(message.from, numero, message._data.notifyName || 'Cliente', produtoConvertido);
                } else {
                    await enviarComSubdivisaoAutomatica(referencia, produtoConvertido, numero, message.from, message);
                    await registrarComprador(message.from, numero, message._data.notifyName || 'Cliente', produto);
                }

                // Marcar pagamento como processado APÓS sucesso
                await marcarPagamentoComoProcessado(referencia, valorEsperado);
                return;
            }

            tentativa++;

            // Se chegou ao limite de tentativas
            if (tentativa > TENTATIVAS_MAX) {
                console.log(`❌ RETRY: Pagamento não encontrado após ${TENTATIVAS_MAX} tentativas em 2 minutos`);
                clearInterval(intervalId);

                await message.reply(
                    `⏰ *TEMPO LIMITE ATINGIDO*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                    `📱 Número: ${numero}\n` +
                    `💵 Valor: ${valorNormalizado}MT\n\n` +
                    `❌ Pagamento não foi encontrado após 2 minutos de tentativas.\n\n` +
                    `🔄 Envie novamente o comprovante ou verifique se o pagamento foi processado corretamente.`
                );
            }

        } catch (error) {
            console.error(`❌ RETRY: Erro na tentativa ${tentativa}:`, error.message);
            tentativa++;

            if (tentativa > TENTATIVAS_MAX) {
                clearInterval(intervalId);
                await message.reply(
                    `❌ *ERRO NO SISTEMA*\n\n` +
                    `💰 Referência: ${referencia}\n\n` +
                    `⚠️ Ocorreu um erro durante as tentativas automáticas. Tente novamente mais tarde.`
                );
            }
        }
    }, INTERVALO_RETRY);

    // Timeout de segurança (2.5 minutos para garantir limpeza)
    setTimeout(() => {
        clearInterval(intervalId);
        console.log(`🛑 RETRY: Timeout de segurança ativado para ${referencia}`);
    }, DURACAO_TOTAL + 30000);
}

// === FUNÇÃO PARA CALCULAR VALOR ESPERADO BASEADO NOS MEGAS ===
function calcularValorEsperadoDosMegas(megas, grupoId) {
    try {
        const configGrupo = getConfiguracaoGrupo(grupoId);
        if (!configGrupo || !configGrupo.precos) {
            console.log(`⚠️ INDIVIDUAL: Grupo ${grupoId} não tem tabela de preços configurada`);
            return null;
        }
        
        // Converter megas para número se for string
        const megasNum = typeof megas === 'string' ? 
            parseInt(megas.replace(/[^\d]/g, '')) : parseInt(megas);
        
        // Buscar o preço correspondente na tabela
        const valorEncontrado = configGrupo.precos[megasNum];
        
        if (valorEncontrado) {
            console.log(`💰 INDIVIDUAL: ${megasNum}MB = ${valorEncontrado}MT`);
            return valorEncontrado;
        }
        
        console.log(`⚠️ INDIVIDUAL: Não encontrou preço para ${megasNum}MB na tabela`);
        return null;
        
    } catch (error) {
        console.error(`❌ INDIVIDUAL: Erro ao calcular valor:`, error);
        return null;
    }
}

// === FUNÇÃO PARA CALCULAR VALOR ESPERADO BASEADO NO SALDO ===
function calcularValorEsperadoDoSaldo(saldo, grupoId) {
    try {
        const configGrupo = getConfiguracaoGrupo(grupoId);
        if (!configGrupo || !configGrupo.precosSaldo) {
            console.log(`⚠️ SALDO: Grupo ${grupoId} não tem tabela de preços de saldo configurada`);
            return null;
        }

        // Converter saldo para número se for string
        const saldoNum = typeof saldo === 'string' ?
            parseInt(saldo.replace(/[^\d]/g, '')) : parseInt(saldo);

        // Buscar o preço correspondente na tabela de saldo
        const valorEncontrado = configGrupo.precosSaldo[saldoNum];

        if (valorEncontrado) {
            console.log(`💰 SALDO: ${saldoNum}MT = ${valorEncontrado}MT`);
            return valorEncontrado;
        }

        console.log(`⚠️ SALDO: Não encontrou preço para ${saldoNum}MT na tabela de saldo`);
        return null;

    } catch (error) {
        console.error(`❌ SALDO: Erro ao calcular valor:`, error);
        return null;
    }
}

// === FUNÇÃO PARA ENVIAR PEDIDOS DE SALDO ===
async function enviarSaldoParaTasker(referencia, saldo, numero, grupoId, messageContext = null) {
    const timestamp = new Date().toLocaleString('pt-BR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const dadosCompletos = `${referencia}|${saldo}|${numero}|${timestamp}`;

    // Verificar duplicados para saldo
    if (dadosParaTasker.some(d => d.dados === dadosCompletos)) {
        const configGrupo = getConfiguracaoGrupo(grupoId);
        const grupoNome = configGrupo ? configGrupo.nome : 'Grupo Desconhecido';

        if (messageContext) {
            await messageContext.reply(
                `⚠️ *PEDIDO DE SALDO DUPLICADO*\n\n` +
                `🔖 **Referência:** ${referencia}\n` +
                `💰 **Saldo:** ${saldo}MT\n` +
                `📱 **Número:** ${numero}\n\n` +
                `⏰ **Este pedido já foi enviado anteriormente.**\n` +
                `🔄 **Se houve erro, contacte o administrador.**`
            );
        }

        console.log(`🛑 SALDO: Pedido duplicado detectado: ${dadosCompletos}`);
        return null;
    }

    try {
        const configGrupo = getConfiguracaoGrupo(grupoId);
        const grupoNome = configGrupo ? configGrupo.nome : 'Grupo Desconhecido';

        // Salvar no arquivo para Tasker
        await salvarArquivoTasker(dadosCompletos, grupoNome, timestamp);

        // Adicionar aos dados para controle
        dadosParaTasker.push({
            dados: dadosCompletos,
            grupo: grupoNome,
            timestamp: timestamp,
            metodo: 'saldo_tasker',
            tipo: 'saldo'
        });

        // Enviar para Google Sheets (planilha de saldo)
        const resultadoSheets = await enviarSaldoParaGoogleSheets(dadosCompletos, grupoId, timestamp);

        if (messageContext) {
            await messageContext.reply(
                `✅ *PEDIDO DE SALDO CRIADO!*\n\n` +
                `🔖 **Referência:** ${referencia}\n` +
                `💰 **Saldo:** ${saldo}MT\n` +
                `📱 **Número:** ${numero}\n` +
                `🏢 **Grupo:** ${grupoNome}\n\n` +
                `🚀 **Pedido enviado para processamento!**\n` +
                `📊 **Status Sistema:** ${resultadoSheets.sucesso ? '✅ Salvo' : '⚠️ Erro'}`
            );
        }

        console.log(`✅ SALDO: Pedido criado: ${dadosCompletos}`);
        return { sucesso: true, dados: dadosCompletos };

    } catch (error) {
        console.error(`❌ SALDO: Erro ao processar:`, error);

        if (messageContext) {
            await messageContext.reply(
                `❌ *ERRO AO PROCESSAR SALDO*\n\n` +
                `⚠️ ${error.message}\n\n` +
                `🔧 Contacte o administrador se o problema persistir.`
            );
        }

        throw error;
    }
}

// === FUNÇÃO PARA ENVIAR SALDO PARA GOOGLE SHEETS ===
async function enviarSaldoParaGoogleSheets(dadosCompletos, grupoId, timestamp) {
    try {
        console.log(`📊 SALDO: Enviando para Google Sheets: ${dadosCompletos}`);

        const payload = {
            grupo_id: grupoId,
            timestamp: timestamp,
            dados: dadosCompletos
        };

        const response = await fetch(GOOGLE_SHEETS_CONFIG_SALDO.scriptUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            timeout: GOOGLE_SHEETS_CONFIG_SALDO.timeout
        });

        if (!response.ok) {
            throw new Error(`Erro HTTP: ${response.status} - ${response.statusText}`);
        }

        const resultado = await response.json();

        if (resultado.success) {
            console.log(`✅ SALDO: Enviado para Google Sheets com sucesso - Linha ${resultado.row}`);
            return { sucesso: true, linha: resultado.row, referencia: resultado.referencia };
        } else {
            console.error(`❌ SALDO: Erro no Google Sheets:`, resultado.error || resultado.message);
            return { sucesso: false, erro: resultado.error || resultado.message };
        }

    } catch (error) {
        console.error(`❌ SALDO: Erro ao enviar para Google Sheets:`, error);
        return { sucesso: false, erro: error.message };
    }
}

// === FUNÇÃO PRINCIPAL PARA TASKER (SEM VERIFICAÇÃO - JÁ VERIFICADO ANTES) ===
async function enviarParaTasker(referencia, megas, numero, grupoId, messageContext = null) {
    const timestamp = new Date().toLocaleString('pt-BR', {
        year: 'numeric',
        month: '2-digit', 
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    // CRIAR STRING COM TIMESTAMP NO FINAL
    const dadosCompletos = `${referencia}|${megas}|${numero}|${timestamp}`;
    
    const grupoNome = getConfiguracaoGrupo(grupoId)?.nome || 'Desconhecido';
    
    console.log(`📊 ENVIANDO DADOS (PAGAMENTO JÁ VERIFICADO):`);
    console.log(`   📋 Dados: ${dadosCompletos}`);
    console.log(`   📍 Grupo: ${grupoNome} (${grupoId})`);
    console.log(`   ⏰ Timestamp: ${timestamp}`);
    
    // Armazenar localmente (backup)
    dadosParaTasker.push({
        dados: dadosCompletos,
        grupo_id: grupoId,
        grupo: grupoNome,
        timestamp: timestamp,
        enviado: false,
        metodo: 'pendente'
    });
    
    // === ENVIAR PARA GOOGLE SHEETS ===
    const resultado = await enviarParaGoogleSheets(dadosCompletos, grupoId, timestamp);
    
    if (resultado.sucesso) {
        dadosParaTasker[dadosParaTasker.length - 1].enviado = true;
        dadosParaTasker[dadosParaTasker.length - 1].metodo = 'google_sheets';
        dadosParaTasker[dadosParaTasker.length - 1].row = resultado.row;
        console.log(`✅ [${grupoNome}] Enviado para Google Sheets! Row: ${resultado.row}`);
    } else if (resultado.duplicado) {
        // Caso especial: Pagamento duplicado
        console.log(`⚠️ [${grupoNome}] Pagamento DUPLICADO detectado: ${resultado.referencia}`);
        dadosParaTasker[dadosParaTasker.length - 1].metodo = 'duplicado';
        dadosParaTasker[dadosParaTasker.length - 1].status = 'duplicado';

        // Notificar no WhatsApp se houver contexto da mensagem
        if (messageContext) {
            try {
                await messageContext.reply(
                    `⚠️ *PAGAMENTO DUPLICADO*\n\n` +
                    `🔍 **Referência:** ${resultado.referencia}\n` +
                    `📋 Este pagamento já foi processado anteriormente\n\n` +
                    `✅ **Não é necessário reenviar**\n` +
                    `💡 O pedido original já está na fila de processamento`
                );
            } catch (error) {
                console.error(`❌ Erro ao enviar notificação de duplicado:`, error);
            }
        }

        // ✅ CONTINUAR PROCESSAMENTO MESMO COM DUPLICADOS
        console.log(`⚠️ DIVISÃO: Pagamento duplicado detectado, mas continuando processamento normal`);
        // Retornar dados normalmente para não quebrar o sistema de divisão

    } else {
        // ❌ FALHA CRÍTICA: Todas as tentativas de retry falharam
        console.error(`❌ [${grupoNome}] FALHA CRÍTICA: Google Sheets falhou após todas as tentativas de retry!`);
        console.error(`❌ Dados NÃO foram salvos: ${dadosCompletos}`);
        dadosParaTasker[dadosParaTasker.length - 1].metodo = 'falha_critica';
        dadosParaTasker[dadosParaTasker.length - 1].erro = resultado.erro;

        // Notificar sobre falha crítica
        if (messageContext) {
            try {
                await messageContext.reply(
                    `❌ *ERRO CRÍTICO NO SISTEMA*\n\n` +
                    `⚠️ **Não foi possível processar o pedido após múltiplas tentativas**\n\n` +
                    `📋 **Dados:** ${dadosCompletos}\n\n` +
                    `🔄 **Por favor, tente novamente em alguns minutos**\n` +
                    `📞 **Se o problema persistir, contacte o suporte**`
                );
            } catch (error) {
                console.error(`❌ Erro ao enviar notificação de falha crítica:`, error);
            }
        }
    }
    
    await salvarArquivoTasker(dadosCompletos, grupoNome, timestamp);
    
    if (dadosParaTasker.length > 100) {
        dadosParaTasker = dadosParaTasker.slice(-100);
    }
    
    return dadosCompletos;
}

// === FUNÇÃO PARA SUBDIVIDIR PEDIDOS INDIVIDUAIS EM BLOCOS DE 10GB ===
async function enviarComSubdivisaoAutomatica(referencia, megasTotal, numero, grupoId, messageContext = null) {
    const LIMITE_MAXIMO_GB = 10240; // 10GB em MB

    console.log(`🔧 SUBDIVISÃO INDIVIDUAL: Analisando pedido ${referencia} - ${megasTotal}MB (${megasTotal/1024}GB) para ${numero}`);

    // Se for 10GB ou menos, enviar normalmente
    if (megasTotal <= LIMITE_MAXIMO_GB) {
        console.log(`✅ SUBDIVISÃO: Pedido dentro do limite (${megasTotal/1024}GB ≤ 10GB), enviando normalmente`);
        return await enviarParaTasker(referencia, megasTotal, numero, grupoId, messageContext);
    }

    // Calcular quantos blocos de 10GB são necessários
    const numeroBlocos = Math.ceil(megasTotal / LIMITE_MAXIMO_GB);
    console.log(`🔧 SUBDIVISÃO: Dividindo ${megasTotal/1024}GB em ${numeroBlocos} blocos de máximo 10GB cada`);

    let megasRestantes = megasTotal;
    let contadorBloco = 1;
    const resultados = [];

    // Criar blocos de exatamente 10GB (exceto o último que pode ser menor)
    while (megasRestantes > 0) {
        const megasDoBloco = megasRestantes >= LIMITE_MAXIMO_GB ? LIMITE_MAXIMO_GB : megasRestantes;
        const referenciaBloco = `${referencia}${String(contadorBloco).padStart(2, '0')}`;

        console.log(`📦 SUBDIVISÃO: Bloco ${contadorBloco}/${numeroBlocos}: ${referenciaBloco} - ${megasDoBloco}MB (${megasDoBloco/1024}GB) para ${numero}`);

        try {
            const resultado = await enviarParaTasker(referenciaBloco, megasDoBloco, numero, grupoId, null);
            resultados.push({
                bloco: contadorBloco,
                referencia: referenciaBloco,
                megas: megasDoBloco,
                numero: numero,
                resultado: resultado,
                sucesso: true
            });

            console.log(`✅ SUBDIVISÃO: Bloco ${contadorBloco} criado com sucesso: ${referenciaBloco}`);

        } catch (error) {
            console.error(`❌ SUBDIVISÃO: Erro no bloco ${contadorBloco}:`, error.message);
            resultados.push({
                bloco: contadorBloco,
                referencia: referenciaBloco,
                megas: megasDoBloco,
                numero: numero,
                erro: error.message,
                sucesso: false
            });
        }

        megasRestantes -= megasDoBloco;
        contadorBloco++;

        // Pequeno delay entre blocos para não sobrecarregar o sistema
        if (megasRestantes > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    // Enviar mensagem de resumo se houver contexto
    if (messageContext) {
        const sucessos = resultados.filter(r => r.sucesso).length;
        const erros = resultados.filter(r => !r.sucesso).length;

        let mensagemResumo = `🔧 *SUBDIVISÃO AUTOMÁTICA*\n\n`;
        mensagemResumo += `💰 **Referência Original:** ${referencia}\n`;
        mensagemResumo += `📊 **Total:** ${megasTotal/1024}GB dividido em ${numeroBlocos} blocos\n`;
        mensagemResumo += `📱 **Número:** ${numero}\n\n`;

        if (erros === 0) {
            mensagemResumo += `✅ **${sucessos}/${numeroBlocos} blocos criados com sucesso!**\n\n`;
            mensagemResumo += `🚀 *O sistema processará as transferências automaticamente.*`;
        } else {
            mensagemResumo += `⚠️ **Resultado:** ${sucessos} sucessos, ${erros} erros\n\n`;
            mensagemResumo += `📋 **Blocos criados:**\n`;
            resultados.filter(r => r.sucesso).forEach(r => {
                mensagemResumo += `   • ${r.referencia}: ${r.megas/1024}GB ✅\n`;
            });
            if (erros > 0) {
                mensagemResumo += `\n❌ **Blocos com erro:**\n`;
                resultados.filter(r => !r.sucesso).forEach(r => {
                    mensagemResumo += `   • ${r.referencia}: ${r.megas/1024}GB ❌\n`;
                });
            }
        }

        try {
            await messageContext.reply(mensagemResumo);
            console.log(`📤 SUBDIVISÃO: Mensagem de resumo enviada - ${sucessos}✅ ${erros}❌`);
        } catch (error) {
            console.error(`❌ SUBDIVISÃO: Erro ao enviar mensagem de resumo:`, error.message);
        }
    }

    const sucessoGeral = resultados.every(r => r.sucesso);
    console.log(`🏁 SUBDIVISÃO: Processo concluído - ${resultados.filter(r => r.sucesso).length}/${numeroBlocos} blocos criados`);

    return {
        sucesso: sucessoGeral,
        totalBlocos: numeroBlocos,
        blocosProcessados: resultados.length,
        blocosSucesso: resultados.filter(r => r.sucesso).length,
        blocosErro: resultados.filter(r => !r.sucesso).length,
        detalhes: resultados
    };
}

// === FUNÇÃO AUXILIAR PARA CÁLCULO DE MEGAS ===
// Esta função deve ser implementada na classe WhatsAppAIAtacado
// Por enquanto, mantemos apenas a estrutura básica

// === FUNÇÃO PARA CONVERTER MEGAS ===
function converterMegasParaNumero(megas) {
    if (typeof megas === 'string') {
        // Remover espaços e converter para maiúsculas
        const megasLimpo = megas.trim().toUpperCase();
        
        // Padrões de conversão
        const padroes = [
            { regex: /(\d+(?:\.\d+)?)\s*GB?/i, multiplicador: 1024 },
            { regex: /(\d+(?:\.\d+)?)\s*MB?/i, multiplicador: 1 },
            { regex: /(\d+(?:\.\d+)?)\s*KB?/i, multiplicador: 1/1024 },
            { regex: /(\d+(?:\.\d+)?)\s*TB?/i, multiplicador: 1024 * 1024 }
        ];
        
        for (const padrao of padroes) {
            const match = megasLimpo.match(padrao.regex);
            if (match) {
                const numero = parseFloat(match[1]);
                const resultado = Math.round(numero * padrao.multiplicador);
                console.log(`🔄 Conversão: ${megas} → ${resultado} MB`);
                return resultado.toString();
            }
        }
        
        // Se não encontrar padrão, tentar extrair apenas números
        const apenasNumeros = megasLimpo.replace(/[^\d.]/g, '');
        if (apenasNumeros) {
            console.log(`🔄 Conversão direta: ${megas} → ${apenasNumeros} MB`);
            return apenasNumeros;
        }
    }
    
    // Se não conseguir converter, retornar o valor original
    console.log(`⚠️ Não foi possível converter: ${megas}`);
    return megas;
}

// REMOVIDO: enviarViaWhatsAppTasker - Sistema de backup via WhatsApp foi substituído por retry robusto

async function salvarArquivoTasker(linhaCompleta, grupoNome, timestamp) {
    try {
        // Arquivo principal para Tasker (apenas a linha)
        await fs.appendFile('tasker_input_atacado.txt', linhaCompleta + '\n');
        
        // Log completo para histórico
        const logLine = `${timestamp} | ${grupoNome} | ${linhaCompleta}\n`;
        await fs.appendFile('tasker_log_atacado.txt', logLine);
        
        console.log(`📁 Arquivo → Backup: ${linhaCompleta}`);
        
    } catch (error) {
        console.error('❌ Erro ao salvar arquivo Tasker:', error);
    }
}

function obterDadosTasker() {
    return dadosParaTasker;
}

function obterDadosTaskerHoje() {
    const hoje = new Date().toDateString();
    return dadosParaTasker.filter(item => {
        const dataItem = new Date(item.timestamp).toDateString();
        return dataItem === hoje;
    });
}

// === MIDDLEWARE DE PROTEÇÃO ===
async function withRetry(operation, maxRetries = 3, delay = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            
            if (error.message && error.message.includes('Execution context was destroyed')) {
                console.log(`⚠️ Contexto destruído detectado na tentativa ${attempt}/${maxRetries}`);
                
                if (attempt < maxRetries) {
                    console.log(`🔄 Aguardando ${delay}ms antes da próxima tentativa...`);
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                    continue;
                }
            }
            
            if (attempt === maxRetries) {
                throw lastError;
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

// === FUNÇÕES AUXILIARES ===

function detectarPerguntaPorNumero(mensagem) {
    const texto = mensagem.toLowerCase();
    
    const padroes = [
        /qual\s+(é\s+)?(o\s+)?número/i,
        /número\s+(de\s+)?(contato|suporte|atendimento)/i,
        /como\s+(falar|contactar|entrar em contacto)/i,
        /preciso\s+(de\s+)?(ajuda|suporte|número)/i,
        /onde\s+(posso\s+)?falar/i,
        /tem\s+(número|contacto|suporte)/i,
        /quero\s+falar\s+com/i,
        /atendimento/i,
        /suporte/i,
        /admin/i,
        /administrador/i,
        /responsável/i,
        /quem\s+(é\s+)?responsável/i,
        /como\s+contactar/i,
        /número\s+do\s+admin/i
    ];
    
    return padroes.some(padrao => padrao.test(texto));
}

function isAdministrador(numero) {
    return ADMINISTRADORES_GLOBAIS.includes(numero);
}

function obterGrupoDoNumero(numeroAdmin) {
    // Extrair apenas o número do ID completo (ex: '258840326152@c.us' -> '258840326152')
    const numeroLimpo = numeroAdmin.replace('@c.us', '');
    return MAPEAMENTO_NUMEROS_GRUPOS[numeroLimpo] || null;
}

// === NOVAS FUNÇÕES PARA SISTEMA DUAL (MEGAS + SALDO) ===

function verificarTipoValor(valor, grupoId) {
    const configGrupo = getConfiguracaoGrupo(grupoId);
    if (!configGrupo) return null;

    // 1. Primeiro verifica se existe na tabela de MEGAS
    if (configGrupo.precos) {
        const valoresValidos = Object.values(configGrupo.precos);
        if (valoresValidos.includes(valor)) {
            // Encontrar quantos megas correspondem a esse valor
            for (const [megas, preco] of Object.entries(configGrupo.precos)) {
                if (preco === valor) {
                    return {
                        tipo: 'megas',
                        quantidade: parseInt(megas),
                        valor: valor,
                        unidade: 'MB'
                    };
                }
            }
        }
    }

    // 2. Se não existe em MEGAS, verifica na tabela de SALDO
    if (configGrupo.precosSaldo) {
        const valoresValidosSaldo = Object.values(configGrupo.precosSaldo);
        if (valoresValidosSaldo.includes(valor)) {
            // Encontrar quanto saldo corresponde a esse valor
            for (const [saldo, preco] of Object.entries(configGrupo.precosSaldo)) {
                if (preco === valor) {
                    return {
                        tipo: 'saldo',
                        quantidade: parseInt(saldo),
                        valor: valor,
                        unidade: 'MT'
                    };
                }
            }
        }
    }

    // 3. Valor não encontrado em nenhuma tabela
    return null;
}

function obterTabelasDisponiveis(grupoId) {
    const configGrupo = getConfiguracaoGrupo(grupoId);
    if (!configGrupo) return { megas: [], saldo: [] };

    const valoresMegas = configGrupo.precos ? Object.values(configGrupo.precos) : [];
    const valoresSaldo = configGrupo.precosSaldo ? Object.values(configGrupo.precosSaldo) : [];

    return {
        megas: valoresMegas,
        saldo: valoresSaldo
    };
}

function isGrupoMonitorado(chatId) {
    return CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
}

function getConfiguracaoGrupo(chatId) {
    return CONFIGURACAO_GRUPOS[chatId] || null;
}

async function isAdminGrupo(chatId, participantId) {
    try {
        if (adminCache[chatId] && adminCache[chatId].timestamp > Date.now() - 300000) {
            return adminCache[chatId].admins.includes(participantId);
        }

        return await withRetry(async () => {
            const chat = await client.getChatById(chatId);
            if (!chat) {
                console.log(`⚠️ Não foi possível acessar o chat ${chatId}`);
                return false;
            }

            const participants = await chat.participants || [];
            const admins = participants.filter(p => p.isAdmin || p.isSuperAdmin).map(p => p.id._serialized);
            
            adminCache[chatId] = {
                admins: admins,
                timestamp: Date.now()
            };

            return admins.includes(participantId);
        });
    } catch (error) {
        console.error('❌ Erro ao verificar admin do grupo:', error);
        return false;
    }
}

function contemConteudoSuspeito(mensagem) {
    const texto = mensagem.toLowerCase();
    const temLink = /(?:https?:\/\/|www\.|\.com|\.net|\.org|\.br|\.mz|bit\.ly|tinyurl|t\.me|wa\.me|whatsapp\.com|telegram\.me|link|url)/i.test(texto);
    
    return {
        temLink: MODERACAO_CONFIG.detectarLinks && temLink,
        suspeito: MODERACAO_CONFIG.detectarLinks && temLink
    };
}

async function deletarMensagem(message) {
    try {
        await message.delete(true);
        console.log(`🗑️ Mensagem deletada`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao deletar mensagem:', error);
        return false;
    }
}

async function removerParticipante(chatId, participantId, motivo) {
    try {
        const chat = await client.getChatById(chatId);
        await chat.removeParticipants([participantId]);
        console.log(`🚫 Participante removido: ${participantId} - ${motivo}`);
        return true;
    } catch (error) {
        console.error('❌ Erro ao remover participante:', error);
        return false;
    }
}

async function aplicarModeracao(message, motivoDeteccao) {
    const chatId = message.from;
    const authorId = message.author || message.from;
    
    try {
        if (!MODERACAO_CONFIG.ativado[chatId]) {
            return;
        }

        if (MODERACAO_CONFIG.excecoes.includes(authorId) || isAdministrador(authorId)) {
            return;
        }

        const isAdmin = await isAdminGrupo(chatId, authorId);
        if (isAdmin) {
            return;
        }

        console.log(`🚨 MODERAÇÃO: ${motivoDeteccao}`);

        if (MODERACAO_CONFIG.apagarMensagem) {
            await deletarMensagem(message);
        }

        if (MODERACAO_CONFIG.removerUsuario) {
            await removerParticipante(chatId, authorId, motivoDeteccao);
        }

    } catch (error) {
        console.error('❌ Erro durante moderação:', error);
    }
}

// === DETECÇÃO DE GRUPOS ===
async function logGrupoInfo(chatId, evento = 'detectado') {
    try {
        const chat = await withRetry(async () => {
            return await client.getChatById(chatId);
        }).catch(() => {
            console.log(`⚠️ Não foi possível acessar informações do grupo ${chatId}`);
            return null;
        });
        
        if (!chat) {
            return null;
        }

        const isGrupoMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
        
        console.log(`\n🔍 ═══════════════════════════════════════`);
        console.log(`📋 GRUPO ${evento.toUpperCase()}`);
        console.log(`🔍 ═══════════════════════════════════════`);
        console.log(`📛 Nome: ${chat.name || 'N/A'}`);
        console.log(`🆔 ID: ${chatId}`);
        console.log(`👥 Participantes: ${chat.participants ? chat.participants.length : 'N/A'}`);
        console.log(`📊 Monitorado: ${isGrupoMonitorado ? '✅ SIM' : '❌ NÃO'}`);
        console.log(`⏰ Data: ${new Date().toLocaleString('pt-BR')}`);
        
        if (!isGrupoMonitorado) {
            console.log(`\n🔧 PARA ADICIONAR ESTE GRUPO:`);
            console.log(`📝 Copie este código para CONFIGURACAO_GRUPOS:`);
            console.log(`\n'${chatId}': {`);
            console.log(`    nome: '${chat.name || 'Nome_do_Grupo'}',`);
            console.log(`    tabela: \`SUA_TABELA_AQUI\`,`);
            console.log(`    pagamento: \`SUAS_FORMAS_DE_PAGAMENTO_AQUI\``);
            console.log(`},\n`);
        }
        
        console.log(`🔍 ═══════════════════════════════════════\n`);
        
        return {
            id: chatId,
            nome: chat.name || 'N/A',
            participantes: chat.participants ? chat.participants.length : 0,
            monitorado: isGrupoMonitorado
        };
        
    } catch (error) {
        console.error(`❌ Erro ao obter informações do grupo ${chatId}:`, error);
        return null;
    }
}

// === HISTÓRICO DE COMPRADORES ===

async function carregarHistorico() {
    try {
        const data = await fs.readFile(ARQUIVO_HISTORICO, 'utf8');
        historicoCompradores = JSON.parse(data);
        console.log('📊 Histórico atacado carregado!');
    } catch (error) {
        console.log('📊 Criando novo histórico atacado...');
        historicoCompradores = {};
    }
}

async function salvarHistorico() {
    try {
        await fs.writeFile(ARQUIVO_HISTORICO, JSON.stringify(historicoCompradores, null, 2));
        console.log('💾 Histórico atacado salvo!');
    } catch (error) {
        console.error('❌ Erro ao salvar histórico:', error);
    }
}

async function registrarComprador(grupoId, numeroComprador, nomeContato, megas) {
    const agora = new Date();
    const timestamp = agora.toISOString();

    if (!historicoCompradores[grupoId]) {
        historicoCompradores[grupoId] = {
            nomeGrupo: getConfiguracaoGrupo(grupoId)?.nome || 'Grupo Desconhecido',
            compradores: {}
        };
    }

    if (!historicoCompradores[grupoId].compradores[numeroComprador]) {
        historicoCompradores[grupoId].compradores[numeroComprador] = {
            primeiraCompra: timestamp,
            ultimaCompra: timestamp,
            totalCompras: 1,
            nomeContato: nomeContato,
            historico: []
        };
    } else {
        historicoCompradores[grupoId].compradores[numeroComprador].ultimaCompra = timestamp;
        historicoCompradores[grupoId].compradores[numeroComprador].totalCompras++;
        historicoCompradores[grupoId].compradores[numeroComprador].nomeContato = nomeContato;
    }

    historicoCompradores[grupoId].compradores[numeroComprador].historico.push({
        data: timestamp,
        megas: megas
    });

    if (historicoCompradores[grupoId].compradores[numeroComprador].historico.length > 10) {
        historicoCompradores[grupoId].compradores[numeroComprador].historico =
            historicoCompradores[grupoId].compradores[numeroComprador].historico.slice(-10);
    }

    await salvarHistorico();
    console.log(`💰 Comprador atacado registrado: ${nomeContato} (${numeroComprador}) - ${megas}`);
}

// === FILA DE MENSAGENS (REMOVIDA) ===
// NOTA: Sistema de backup via WhatsApp foi completamente removido
// Agora usa apenas retry robusto com backoff exponencial para Google Sheets

// === EVENTOS DO BOT ===

client.on('qr', (qr) => {
    console.log('📱 BOT ATACADO - Escaneie o QR Code:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ Event ready fired! Bot ATACADO conectado e pronto!');
    console.log('🧠 IA WhatsApp ATACADO ativa!');
    console.log('📦 Sistema inteligente: Cálculo automático de megas!');
    console.log('📊 Google Sheets ATACADO configurado!');
    console.log('🔄 Bot de Divisão ATIVO - Múltiplos números automático!');
    console.log(`🔗 URL: ${GOOGLE_SHEETS_CONFIG_ATACADO.scriptUrl}`);
    
    await carregarHistorico();
    
    console.log('\n🤖 Monitorando grupos ATACADO:');
    Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
        const config = CONFIGURACAO_GRUPOS[grupoId];
        console.log(`   📋 ${config.nome} (${grupoId})`);
    });
    
    console.log('\n🔧 Comandos admin: .ia .divisao .test_busca .stats .sheets .test_sheets .test_grupo .grupos_status .grupos .grupo_atual .debug_grupo .pedido');
});

client.on('group-join', async (notification) => {
    try {
        const chatId = notification.chatId;
        
        // Detectar se o bot foi adicionado
        const addedParticipants = notification.recipientIds || [];
        try {
            const botInfo = await client.info;
            
            if (botInfo && addedParticipants.includes(botInfo.wid._serialized)) {
                console.log(`\n🤖 BOT ATACADO ADICIONADO A UM NOVO GRUPO!`);
                await logGrupoInfo(chatId, 'BOT ATACADO ADICIONADO');
            
            setTimeout(async () => {
                try {
                    const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(chatId);
                    const mensagem = isMonitorado ? 
                        `🤖 *BOT ATACADO ATIVO E CONFIGURADO!*\n\nEste grupo está monitorado e o sistema automático já está funcionando.\n\n📋 Digite: *tabela* (ver preços)\n💳 Digite: *pagamento* (ver formas)\n💰 Digite: *saldo* (ver tabela saldo)\n\n⚠️ *ATACADO: Cálculo automático de megas*` :
                        `🤖 *BOT ATACADO CONECTADO!*\n\n⚙️ Este grupo ainda não está configurado.\n🔧 Contacte o administrador para ativação.\n\n📝 ID do grupo copiado no console do servidor.`;
                    
                    await client.sendMessage(chatId, mensagem);
                    console.log(`✅ Mensagem de status enviada`);
                } catch (error) {
                    console.error('❌ Erro ao enviar mensagem de status:', error);
                }
            }, 3000);
            }
        } catch (error) {
            console.error('❌ Erro ao verificar info do bot:', error);
        }
        
        // Código original do grupo já configurado
        const configGrupo = getConfiguracaoGrupo(chatId);
        if (configGrupo) {
            console.log(`👋 Novo membro no grupo ${configGrupo.nome}`);
            
            const mensagemBoasVindas = `
�� *SISTEMA ATACADO - CÁLCULO AUTOMÁTICO DE MEGAS* 

Bem-vindo(a) ao *${configGrupo.nome}*! 

✨ *Aqui usamos sistema atacado inteligente!*

🛒 *Como comprar:*
1️⃣ Faça o pagamento 
2️⃣ Envie comprovante + UM número
3️⃣ Sistema calcula megas automaticamente!
4️⃣ Receba megas no número!

📋 Digite: *tabela* (ver preços)
💳 Digite: *pagamento* (ver formas)

⚡ *Cálculo automático baseado na tabela!*
            `;
            
            setTimeout(async () => {
                try {
                    await client.sendMessage(chatId, mensagemBoasVindas);
                    console.log(`✅ Mensagem de boas-vindas enviada`);
                } catch (error) {
                    console.error('❌ Erro ao enviar boas-vindas:', error);
                }
            }, 2000);
        }
    } catch (error) {
        console.error('❌ Erro no evento group-join:', error);
    }
});

client.on('message', async (message) => {
    try {
        // === IGNORAR MENSAGENS DE SALDO TRANSFERIDO (PRIMEIRO FILTRO) ===
        if (message.body && message.body.startsWith('✅Saldo Transferido Com Sucesso')) {
            console.log('🚫 Mensagem de saldo transferido ignorada');
            return;
        }

        const isPrivado = !message.from.endsWith('@g.us');
        const isAdmin = isAdministrador(message.from);

        // === COMANDOS ADMINISTRATIVOS ===
        if (isAdmin) {
            const mensagemOriginal = message.body.trim();
            const comando = mensagemOriginal.toLowerCase();

            if (comando === '.ia') {
                const statusIA = ia.getStatusDetalhado();
                await message.reply(statusIA);
                console.log(`🧠 Comando .ia executado`);
                return;
            }

            // NOVO COMANDO: Status do bot de divisão
            if (comando === '.divisao') {
                const status = botDivisao.getStatus();
                const resposta = `🔄 *BOT DE DIVISÃO STATUS*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `💾 Comprovativos memorizados: ${status.comprovantesMemorizados}\n` +
                    `⚡ Divisões em processamento: ${status.processandoDivisoes}\n` +
                    `🏢 Grupos configurados: ${status.gruposConfigurados}\n\n` +
                    `✅ Sistema ativo e funcionando!`;
                
                await message.reply(resposta);
                return;
            }
            
            // NOVO COMANDO: Testar busca de pagamento
            if (comando.startsWith('.test_busca ')) {
                const parametros = mensagemOriginal.replace(/^\.test_busca\s+/i, '').split(' ');
                if (parametros.length >= 2) {
                    const referencia = parametros[0];
                    const valor = parseFloat(parametros[1]);
                    
                    console.log(`🧪 Testando busca: ${referencia} - ${valor}MT`);
                    
                    const resultado = await botDivisao.buscarPagamentoNaPlanilha(referencia, valor);
                    
                    const resposta = resultado ? 
                        `✅ *PAGAMENTO ENCONTRADO*\n\n🔍 Referência: ${referencia}\n💰 Valor: ${valor}MT` :
                        `❌ *PAGAMENTO NÃO ENCONTRADO*\n\n🔍 Referência: ${referencia}\n💰 Valor: ${valor}MT`;
                    
                    await message.reply(resposta);
                } else {
                    await message.reply('❌ Uso: .test_busca REFERENCIA VALOR\nExemplo: .test_busca CHP4H5DMI1S 375');
                }
                return;
            }

            if (comando === '.stats') {
                let stats = `📊 *ESTATÍSTICAS ATACADO*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
                    const config = CONFIGURACAO_GRUPOS[grupoId];
                    const dados = historicoCompradores[grupoId];
                    const totalCompradores = dados ? Object.keys(dados.compradores || {}).length : 0;
                    
                    if (totalCompradores > 0) {
                        stats += `🏢 *${config.nome}*\n`;
                        stats += `👥 ${totalCompradores} compradores\n\n`;
                    }
                });
                
                await message.reply(stats);
                return;
            }

            // === COMANDOS GOOGLE SHEETS ===
            if (comando === '.test_sheets') {
                console.log(`🧪 Testando Google Sheets...`);
                
                const resultado = await enviarParaGoogleSheets('TEST123|1250|842223344|' + new Date().toLocaleString('pt-BR'), 'test_group', new Date().toLocaleString('pt-BR'));
                
                if (resultado.sucesso) {
                    await message.reply(`✅ *Sistema funcionando!*\n\n📊 Conexão ativa\n📝 Row: ${resultado.row}\n🎉 Dados enviados com sucesso!`);
                } else {
                    await message.reply(`❌ *Sistema com problema!*\n\n📊 Conexão falhou\n⚠️ Erro: ${resultado.erro}\n\n🔧 *Verifique:*\n• Conexão com internet\n• Sistema funcionando`);
                }
                return;
            }

            if (comando === '.test_grupo') {
                const grupoAtual = message.from;
                const configGrupo = getConfiguracaoGrupo(grupoAtual);
                
                if (!configGrupo) {
                    await message.reply('❌ Este grupo não está configurado!');
                    return;
                }
                
                console.log(`🧪 Testando Google Sheets para grupo: ${configGrupo.nome}`);
                
                const resultado = await enviarParaGoogleSheets('TEST999|1250|847777777|' + new Date().toLocaleString('pt-BR'), grupoAtual, new Date().toLocaleString('pt-BR'));
                
                if (resultado.sucesso) {
                    await message.reply(`✅ *Teste enviado para ${configGrupo.nome}!*\n\n📊 Row: ${resultado.row}\n🔍 O celular deste grupo deve processar em até 30 segundos.\n\n📱 *Grupo ID:* \`${grupoAtual}\``);
                } else {
                    await message.reply(`❌ *Erro no teste:* ${resultado.erro}`);
                }
                return;
            }

            if (comando === '.grupos_status') {
                let resposta = `📊 *STATUS DOS GRUPOS ATACADO*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                
                for (const [grupoId, config] of Object.entries(CONFIGURACAO_GRUPOS)) {
                    const dadosGrupo = dadosParaTasker.filter(d => d.grupo_id === grupoId);
                    const hoje = dadosGrupo.filter(d => {
                        const dataItem = new Date(d.timestamp).toDateString();
                        return dataItem === new Date().toDateString();
                    });
                    
                    resposta += `🏢 *${config.nome}*\n`;
                    resposta += `   📈 Total: ${dadosGrupo.length}\n`;
                    resposta += `   📅 Hoje: ${hoje.length}\n`;
                    resposta += `   ✅ Enviados: ${dadosGrupo.filter(d => d.metodo === 'google_sheets').length}\n`;
                    resposta += `   ❌ Falhas: ${dadosGrupo.filter(d => d.metodo === 'falha_critica').length}\n`;
                    resposta += `   🆔 ID: \`${grupoId}\`\n\n`;
                }
                
                await message.reply(resposta);
                return;
            }

            if (comando === '.sheets') {
                const dados = obterDadosTasker();
                const hoje = obterDadosTaskerHoje();
                const sheets = dados.filter(d => d.metodo === 'google_sheets').length;
                const falhas = dados.filter(d => d.metodo === 'falha_critica').length;
                const duplicados = dados.filter(d => d.metodo === 'duplicado').length;

                let resposta = `📊 *GOOGLE SHEETS STATUS ATACADO*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                resposta += `📈 Total processado: ${dados.length}\n`;
                resposta += `📅 Hoje: ${hoje.length}\n`;
                resposta += `✅ Enviados com sucesso: ${sheets}\n`;
                resposta += `⚠️ Duplicados: ${duplicados}\n`;
                resposta += `❌ Falhas críticas: ${falhas}\n\n`;

                if (dados.length > 0) {
                    resposta += `📋 *Últimos 5 processados:*\n`;
                    dados.slice(-5).forEach((item, index) => {
                        const emoji = item.metodo === 'google_sheets' ? '✅' :
                                     item.metodo === 'duplicado' ? '⚠️' : '❌';
                        resposta += `${index + 1}. ${emoji} ${item.dados} (${item.grupo})\n`;
                    });
                }

                await message.reply(resposta);
                return;
            }

            if (comando.startsWith('.clear_grupo ')) {
                const nomeGrupo = mensagemOriginal.replace(/^\.clear_grupo\s+/i, '');
                const antes = dadosParaTasker.length;
                
                dadosParaTasker = dadosParaTasker.filter(d => !d.grupo.toLowerCase().includes(nomeGrupo.toLowerCase()));
                
                const removidos = antes - dadosParaTasker.length;
                await message.reply(`🗑️ *${removidos} registros do grupo "${nomeGrupo}" removidos!*`);
                return;
            }

            if (comando === '.clear_sheets') {
                dadosParaTasker = [];
                await message.reply('🗑️ *Dados do sistema limpos!*');
                return;
            }

            // === COMANDOS PARA DETECÇÃO DE GRUPOS ===
            if (comando === '.grupos') {
                try {
                    let resposta = `📋 *GRUPOS CONFIGURADOS ATACADO*\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                    // Mostrar grupo padrão do admin (se existir)
                    const meuGrupo = obterGrupoDoNumero(message.from);
                    if (meuGrupo) {
                        const configMeuGrupo = getConfiguracaoGrupo(meuGrupo);
                        resposta += `🏠 *SEU GRUPO PADRÃO:*\n`;
                        resposta += `📋 ${configMeuGrupo.nome}\n`;
                        resposta += `🆔 ${meuGrupo}\n\n`;
                    }

                    resposta += `📊 *TODOS OS GRUPOS:*\n`;
                    Object.keys(CONFIGURACAO_GRUPOS).forEach(grupoId => {
                        const config = CONFIGURACAO_GRUPOS[grupoId];
                        const isMeuGrupo = meuGrupo === grupoId ? ' ⭐' : '';
                        resposta += `📋 ${config.nome}${isMeuGrupo}\n`;
                        resposta += `🆔 \`${grupoId}\`\n\n`;
                    });

                    resposta += `💡 *MAPEAMENTO DE ADMINS:*\n`;
                    Object.keys(MAPEAMENTO_NUMEROS_GRUPOS).forEach(numero => {
                        const grupoId = MAPEAMENTO_NUMEROS_GRUPOS[numero];
                        const config = getConfiguracaoGrupo(grupoId);
                        resposta += `📱 ${numero} → ${config.nome}\n`;
                    });

                    const chats = await client.getChats();
                    const grupos = chats.filter(chat => chat.isGroup);
                    
                    resposta += `📊 Total de grupos: ${grupos.length}\n\n`;
                    
                    for (const grupo of grupos) {
                        const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupo.id._serialized);
                        const status = isMonitorado ? '✅' : '❌';
                        
                        resposta += `${status} *${grupo.name}*\n`;
                        resposta += `   🆔 \`${grupo.id._serialized}\`\n`;
                        resposta += `   👥 ${grupo.participants.length} membros\n\n`;
                    }
                    
                    resposta += `\n🔧 *Para adicionar grupo:*\nCopie ID e adicione em CONFIGURACAO_GRUPOS`;
                    
                    await message.reply(resposta);
                    
                    console.log(`\n📋 COMANDO .grupos executado - ${grupos.length} grupos encontrados`);
                    grupos.forEach(grupo => {
                        const isMonitorado = CONFIGURACAO_GRUPOS.hasOwnProperty(grupo.id._serialized);
                        console.log(`${isMonitorado ? '✅' : '❌'} ${grupo.name}: ${grupo.id._serialized}`);
                    });
                    
                } catch (error) {
                    console.error('❌ Erro ao listar grupos:', error);
                    await message.reply('❌ Erro ao obter lista de grupos');
                }
                return;
            }

            if (comando === '.grupo_atual') {
                if (!message.from.endsWith('@g.us')) {
                    await message.reply('❌ Use este comando em um grupo!');
                    return;
                }
                
                await logGrupoInfo(message.from, 'COMANDO .grupo_atual');
                
                const configGrupo = getConfiguracaoGrupo(message.from);
                const status = configGrupo ? '✅ CONFIGURADO' : '❌ NÃO CONFIGURADO';
                
                await message.reply(
                    `📋 *INFORMAÇÕES DESTE GRUPO ATACADO*\n\n` +
                    `🆔 ID: \`${message.from}\`\n` +
                    `📊 Status: ${status}\n\n` +
                    `${configGrupo ? `🏢 Nome: ${configGrupo.nome}` : '🔧 Precisa ser configurado'}\n\n` +
                    `📝 Verifique o console para detalhes completos`
                );
                return;
            }

            // NOVO COMANDO: Verificar IDs dos grupos atuais
            if (comando === '.debug_grupo') {
                const grupoInfo = {
                    id: message.from,
                    isGrupo: message.from.endsWith('@g.us'),
                    isMonitorado: isGrupoMonitorado(message.from),
                    configExiste: !!getConfiguracaoGrupo(message.from)
                };
                
                await message.reply(
                    `🔍 *DEBUG GRUPO*\n\n` +
                    `🆔 ID: \`${grupoInfo.id}\`\n` +
                    `📱 É grupo: ${grupoInfo.isGrupo ? '✅' : '❌'}\n` +
                    `📊 Monitorado: ${grupoInfo.isMonitorado ? '✅' : '❌'}\n` +
                    `⚙️ Config existe: ${grupoInfo.configExiste ? '✅' : '❌'}\n\n` +
                    `📋 *Grupos configurados:*\n${Object.keys(CONFIGURACAO_GRUPOS).join('\n')}`
                );
                return;
            }

            // NOVO COMANDO: .pedido - Permite ao admin criar pedidos diretamente (APENAS PRIVADO)
            if (comando.startsWith('.pedido ')) {
                // Verificar se está sendo usado no privado
                if (!isPrivado) {
                    await message.reply('❌ Este comando só pode ser usado no chat privado!\n\n🔒 Mande uma mensagem privada para o bot para usar este comando.');
                    return;
                }

                const parametros = mensagemOriginal.replace(/^\.pedido\s+/i, '').trim();
                const partes = parametros.split(' ');

                if (partes.length < 3) {
                    await message.reply(
                        `❌ *Uso do comando .pedido*\n\n` +
                        `📝 **Formato:** .pedido REFERENCIA MEGAS NUMERO [GRUPO_ID]\n\n` +
                        `💡 **Exemplos:**\n` +
                        `• .pedido ADMIN001 10240 847777777\n` +
                        `• .pedido PROMO123 20480 848888888 120363419652375064@g.us\n\n` +
                        `📊 **MEGAS em MB:** 10240 = 10GB, 20480 = 20GB, etc.\n` +
                        `🏢 **GRUPO_ID:** Opcional - se não informado, usa seu grupo padrão\n` +
                        `💡 Use .grupos para ver IDs disponíveis`
                    );
                    return;
                }

                const [referencia, megas, numero, grupoIdManual] = partes;

                // Determinar o grupo: manual ou automático baseado no admin
                let grupoId;
                if (grupoIdManual) {
                    grupoId = grupoIdManual;
                } else {
                    grupoId = obterGrupoDoNumero(message.from);
                    if (!grupoId) {
                        await message.reply(
                            `❌ *Grupo não configurado para seu número!*\n\n` +
                            `🔧 Você precisa especificar o GRUPO_ID manualmente:\n` +
                            `📝 .pedido ${referencia} ${megas} ${numero} GRUPO_ID\n\n` +
                            `💡 Use .grupos para ver grupos disponíveis`
                        );
                        return;
                    }
                }

                const configGrupo = getConfiguracaoGrupo(grupoId);

                // Verificar se o grupo está configurado
                if (!configGrupo) {
                    await message.reply('❌ Grupo não configurado no sistema!\n\n💡 Use .grupos para ver grupos disponíveis.');
                    return;
                }

                // Validar formato dos parâmetros
                const megasNum = parseInt(megas);
                if (isNaN(megasNum) || megasNum <= 0) {
                    await message.reply('❌ Megas deve ser um número positivo (ex: 10240 para 10GB)');
                    return;
                }

                // Validar número de telefone
                if (!/^\d{9,12}$/.test(numero)) {
                    await message.reply('❌ Número inválido! Use formato: 847777777 ou 258847777777');
                    return;
                }

                const grupoTipo = grupoIdManual ? 'manual' : 'automático';
                console.log(`🔧 ADMIN: Comando .pedido executado pelo admin no privado`);
                console.log(`   📋 Referência: ${referencia}`);
                console.log(`   📊 Megas: ${megasNum} (${Math.floor(megasNum/1024)}GB)`);
                console.log(`   📱 Número: ${numero}`);
                console.log(`   🏢 Grupo: ${configGrupo.nome} (${grupoTipo})`);
                console.log(`   🆔 ID: ${grupoId}`);

                try {
                    // Enviar pedido direto para o sistema
                    const resultadoEnvio = await enviarParaTasker(
                        referencia,
                        megasNum,
                        numero,
                        grupoId,
                        message
                    );

                    if (resultadoEnvio === null) {
                        console.log(`🛑 ADMIN: Pedido duplicado detectado`);
                        return; // Mensagem de duplicado já foi enviada
                    }

                    // Registrar no histórico
                    const nomeAdmin = message._data.notifyName || 'Admin';
                    await registrarComprador(grupoId, numero, `${nomeAdmin} (Admin)`, megasNum);

                    // Resposta de sucesso
                    await message.reply(
                        `✅ *PEDIDO ADMINISTRATIVO CRIADO!*\n\n` +
                        `💰 **Referência:** ${referencia}\n` +
                        `📊 **Megas:** ${Math.floor(megasNum/1024)}GB (${megasNum}MB)\n` +
                        `📱 **Número:** ${numero}\n` +
                        `🏢 **Grupo:** ${configGrupo.nome}\n\n` +
                        `⏳ *O sistema irá processar em instantes...*`
                    );

                    console.log(`✅ ADMIN: Pedido administrativo criado com sucesso!`);

                } catch (error) {
                    console.error(`❌ ADMIN: Erro ao criar pedido:`, error);
                    await message.reply(
                        `❌ *Erro ao criar pedido administrativo*\n\n` +
                        `⚠️ ${error.message}\n\n` +
                        `🔧 Tente novamente ou contacte o suporte técnico.`
                    );
                }
                return;
            }
        }

        // === DETECÇÃO DE GRUPOS NÃO CONFIGURADOS ===
        if (message.from.endsWith('@g.us') && !isGrupoMonitorado(message.from) && !message.fromMe) {
            if (!gruposLogados.has(message.from)) {
                await logGrupoInfo(message.from, 'MENSAGEM RECEBIDA');
                gruposLogados.add(message.from);
                
                // Limpar cache a cada 50 grupos para evitar memory leak
                if (gruposLogados.size > 50) {
                    gruposLogados.clear();
                }
            }
        }

        // === COMANDOS BÁSICOS (PARA TODAS AS MENSAGENS) ===
        const textoMensagem = message.body ? message.body.toLowerCase().trim() : '';

        if (textoMensagem === 'teste') {
            await message.reply('🤖 Bot funcionando normalmente!');
            return;
        }
        
        if (textoMensagem === 'tabela') {
            const configGrupoBasico = getConfiguracaoGrupo(message.from);
            if (configGrupoBasico && configGrupoBasico.tabela) {
                await message.reply(configGrupoBasico.tabela);
            } else {
                await message.reply('❌ Tabela não configurada para este grupo.');
            }
            return;
        }
        
        if (textoMensagem === 'pagamento') {
            const configGrupoBasico = getConfiguracaoGrupo(message.from);
            if (configGrupoBasico && configGrupoBasico.pagamento) {
                await message.reply(configGrupoBasico.pagamento);
            } else {
                await message.reply('❌ Informações de pagamento não configuradas para este grupo.');
            }
            return;
        }

        if (textoMensagem === 'saldo') {
            const configGrupoBasico = getConfiguracaoGrupo(message.from);
            if (configGrupoBasico && configGrupoBasico.saldo) {
                await message.reply(configGrupoBasico.saldo);
            } else {
                await message.reply('❌ Informações de saldo não configuradas para este grupo.');
            }
            return;
        }

        // === PROCESSAMENTO DE GRUPOS ===
        if (!message.from.endsWith('@g.us') || !isGrupoMonitorado(message.from)) {
            return;
        }

        const configGrupo = getConfiguracaoGrupo(message.from);
        if (!configGrupo || message.fromMe) {
            return;
        }

        // === MODERAÇÃO ===
        if (message.type === 'chat') {
            const analise = contemConteudoSuspeito(message.body);
            
            if (analise.suspeito) {
                console.log(`🚨 Conteúdo suspeito detectado`);
                await aplicarModeracao(message, "Link detectado");
                return;
            }
        }

        // === PROCESSAMENTO DE IMAGENS REMOVIDO ===
        if (message.type === 'image') {
            await message.reply(
                '❌ Processamento de imagens desativado\n' +
                '📄 Solicitamos que o comprovante seja enviado em formato de texto.\n\n' +
                'ℹ️ Esta medida foi adotada para garantir que o sistema funcione de forma mais rápida, estável e com menos falhas.'
            );
            return;
        }

        if (message.type !== 'chat') {
            return;
        }

        // TESTE SIMPLES - Comando de teste
        if (/^!teste$/i.test(message.body)) {
            await message.reply(`✅ Bot funcionando! Grupo: ${configGrupo.nome}`);
            return;
        }

        // Comandos de tabela e pagamento
        if (/tabela/i.test(message.body)) {
            await message.reply(configGrupo.tabela);
            return;
        }

        if (/pagamento/i.test(message.body)) {
            await message.reply(configGrupo.pagamento);
            return;
        }

        // === DETECÇÃO DE PERGUNTA POR NÚMERO (NÃO-ADMIN) ===
        if (!isAdmin && detectarPerguntaPorNumero(message.body)) {
            console.log(`📱 Pergunta por número detectada de não-admin`);
            await message.reply(
                `📱 *Para solicitar número ou suporte:*\n\n` +
                `💳 *Primeiro faça o pagamento:*\n\n` +
                `${configGrupo.pagamento}\n\n` +
                `📝 *Depois envie:*\n` +
                `• Comprovante de pagamento\n` +
                `• UM número que vai receber\n\n` +
                `🤖 *Sistema atacado - valor integral!*`
            );
            return;
        }

        // === BOT DE DIVISÃO (ANTES DA IA) ===
        const remetente = message.author || message.from;
        const resultadoDivisao = await botDivisao.processarMensagem(message, remetente, message.from);
        
        if (resultadoDivisao) {
            // Se a mensagem foi ignorada pelo bot de divisão, parar aqui
            if (resultadoDivisao.ignorado) {
                console.log('🚫 DIVISÃO: Mensagem ignorada pelo bot de divisão');
                return;
            }

            console.log('🔄 DIVISÃO: Mensagem processada pelo bot de divisão');

            // Se o bot de divisão retornou uma resposta, enviar
            if (resultadoDivisao.resposta) {
                await message.reply(resultadoDivisao.resposta);
            }

            // Se foi processado com sucesso, não continuar para o bot original
            if (resultadoDivisao.processado) {
                if (resultadoDivisao.duplicados > 0) {
                    console.log(`✅ DIVISÃO: ${resultadoDivisao.sucessos}/${resultadoDivisao.total} pedidos criados, ${resultadoDivisao.duplicados} duplicados`);
                } else {
                    console.log(`✅ DIVISÃO: ${resultadoDivisao.sucessos}/${resultadoDivisao.total} pedidos criados`);
                }
                return; // IMPORTANTE: Sair aqui, não processar no bot original
            }

            // Se retornou uma resposta mas não foi processado, também sair
            if (resultadoDivisao.resposta) {
                return;
            }
        }

        // === PROCESSAMENTO COM IA ===
        const resultadoIA = await ia.processarMensagemBot(message.body, remetente, 'texto', configGrupo);
        
        if (resultadoIA.erro) {
            console.error(`❌ Erro na IA:`, resultadoIA.mensagem);
            return;
        }

        if (resultadoIA.sucesso) {
            
            if (resultadoIA.tipo === 'comprovante_recebido') {
                // Detectar se é saldo ou megas baseado no que a IA retornou
                const isSaldoComprovante = resultadoIA.tipoProduto === 'saldo';
                const produtoTexto = isSaldoComprovante ? `${resultadoIA.saldo || resultadoIA.megas}MT` : resultadoIA.megas;
                const tipoProdutoTexto = isSaldoComprovante ? 'Saldo' : 'Megas';

                await message.reply(
                    `✅ *Comprovante processado!*\n\n` +
                    `💰 Referência: ${resultadoIA.referencia}\n` +
                    `📊 ${tipoProdutoTexto}: ${produtoTexto}\n\n` +
                    `📱 *Envie UM número que vai receber ${produtoTexto}!*`
                );
                return;
                
            } else if (resultadoIA.tipo === 'numero_processado' || resultadoIA.tipo === 'saldo_processado') {
                const dadosCompletos = resultadoIA.dadosCompletos;
                const [referencia, produto, numero] = dadosCompletos.split('|');
                const nomeContato = message._data.notifyName || 'N/A';
                const autorMensagem = message.author || 'Desconhecido';

                // Verificar se é saldo ou megas
                const isSaldo = resultadoIA.tipo === 'saldo_processado';

                // Converter produto para formato numérico (megas ou saldo)
                const produtoConvertido = isSaldo ? parseInt(produto) : converterMegasParaNumero(produto);
                
                // === NOVA VERIFICAÇÃO: CONFIRMAR PAGAMENTO ANTES DE PROCESSAR ===
                console.log(`🔍 INDIVIDUAL: Verificando pagamento antes de processar texto (${isSaldo ? 'SALDO' : 'MEGAS'})...`);

                // 1. Usar valor do comprovante se disponível, senão calcular
                let valorEsperado;
                if (resultadoIA.valorPago && resultadoIA.valorPago > 0) {
                    // Se a IA extraiu o valor do comprovante, usar esse valor
                    valorEsperado = normalizarValor(resultadoIA.valorPago);
                    console.log(`💰 INDIVIDUAL: Usando valor do comprovante: ${valorEsperado}MT`);
                } else {
                    // Senão, calcular baseado no tipo (saldo ou megas)
                    valorEsperado = isSaldo ?
                        calcularValorEsperadoDoSaldo(produtoConvertido, message.from) :
                        calcularValorEsperadoDosMegas(produtoConvertido, message.from);
                    console.log(`💰 INDIVIDUAL: Calculando valor baseado no ${isSaldo ? 'saldo' : 'megas'}: ${valorEsperado}MT`);
                }
                
                if (!valorEsperado) {
                    console.log(`⚠️ INDIVIDUAL: Não foi possível calcular valor, processando sem verificação`);

                    if (isSaldo) {
                        // Processar saldo
                        await enviarSaldoParaTasker(referencia, produtoConvertido, numero, message.from, message);
                        await registrarComprador(message.from, numero, nomeContato, produtoConvertido);
                    } else {
                        // Processar megas
                        await enviarComSubdivisaoAutomatica(referencia, produtoConvertido, numero, message.from, message);
                        await registrarComprador(message.from, numero, nomeContato, resultadoIA.valorPago || produto);
                    }

                    // REMOVIDO: Sistema de encaminhamento via WhatsApp substituído por retry robusto

                    const tipoProdutoTexto = isSaldo ? 'Saldo' : 'Megas';
                    const produtoTexto = isSaldo ? `${produtoConvertido}MT` : produto;

                    await message.reply(
                        `✅ *Pedido processado!*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                        `📱 Número: ${numero}\n\n` +
                        `⏳ *Aguarde uns instantes enquanto o sistema executa a transferência*`
                    );
                    return;
                }
                
                // 2. Verificar se pagamento existe
                const pagamentoConfirmado = await verificarPagamentoIndividual(referencia, valorEsperado);

                // CASO ESPECIAL: Pagamento já foi processado
                if (pagamentoConfirmado === 'ja_processado') {
                    const valorNormalizado = normalizarValor(valorEsperado);
                    const tipoProdutoTexto = isSaldo ? 'Saldo' : 'Megas';
                    const produtoTexto = isSaldo ? `${produtoConvertido}MT` : produto;

                    console.log(`⚠️ INDIVIDUAL: Pagamento já processado - ${referencia} (${valorNormalizado}MT)`);

                    await message.reply(
                        `⚠️ *PAGAMENTO JÁ PROCESSADO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                        `💵 Valor: ${valorNormalizado}MT\n\n` +
                        `✅ Este pagamento já foi processado anteriormente. Não é necessário enviar novamente.\n\n` +
                        `Se você acredita que isso é um erro, entre em contato com o suporte.`
                    );
                    return;
                }

                if (!pagamentoConfirmado) {
                    const valorNormalizado = normalizarValor(valorEsperado);
                    const tipoProdutoTexto = isSaldo ? 'Saldo' : 'Megas';
                    const produtoTexto = isSaldo ? `${produtoConvertido}MT` : produto;
                    console.log(`❌ INDIVIDUAL: Pagamento não confirmado para texto (${tipoProdutoTexto}) - ${referencia} (${valorNormalizado}MT)`);

                    // Primeira mensagem informando o início das tentativas automáticas
                    await message.reply(
                        `⏳ *AGUARDANDO CONFIRMAÇÃO DO PAGAMENTO*\n\n` +
                        `💰 Referência: ${referencia}\n` +
                        `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                        `📱 Número: ${numero}\n` +
                        `💳 Valor esperado: ${valorNormalizado}MT\n\n` +
                        `🔄 **Iniciando tentativas automáticas...**\n` +
                        `⏰ Vou verificar a cada 15 segundos por 2 minutos\n` +
                        `✨ Não é necessário reenviar o comprovante!`
                    );

                    // Iniciar retry automático
                    const dadosCompletos = {
                        isSaldo,
                        produtoConvertido,
                        produto,
                        numero,
                        valorNormalizado,
                        tipoProdutoTexto,
                        produtoTexto
                    };

                    await tentarPagamentoComRetryAutomatico(referencia, valorEsperado, dadosCompletos, message);
                    return;
                }
                
                console.log(`✅ INDIVIDUAL: Pagamento confirmado para texto (${isSaldo ? 'SALDO' : 'MEGAS'})! Processando...`);

                // 3. Se pagamento confirmado, processar normalmente
                if (isSaldo) {
                    // Processar saldo
                    await enviarSaldoParaTasker(referencia, produtoConvertido, numero, message.from, message);
                    await registrarComprador(message.from, numero, nomeContato, produtoConvertido);

                    // Marcar pagamento como processado APÓS sucesso
                    await marcarPagamentoComoProcessado(referencia, valorEsperado);
                } else {
                    // Processar megas
                    await enviarComSubdivisaoAutomatica(referencia, produtoConvertido, numero, message.from, message);
                    await registrarComprador(message.from, numero, nomeContato, resultadoIA.valorPago || produto);

                    // Marcar pagamento como processado APÓS sucesso
                    await marcarPagamentoComoProcessado(referencia, valorEsperado);
                }

                // REMOVIDO: Sistema de encaminhamento via WhatsApp substituído por retry robusto

                const tipoProdutoTexto = isSaldo ? 'Saldo' : 'Megas';
                const produtoTexto = isSaldo ? `${produtoConvertido}MT` : produto;

                await message.reply(
                    `✅ *Pedido processado!*\n\n` +
                    `💰 Referência: ${referencia}\n` +
                    `📊 ${tipoProdutoTexto}: ${produtoTexto}\n` +
                    `📱 Número: ${numero}\n` +
                    `💳 Pagamento: ${normalizarValor(valorEsperado)}MT confirmado\n\n` +
                    `⏳ *Aguarde uns instantes enquanto o sistema executa a transferência*`
                );
                return;
            }
        }

        // === TRATAMENTO DE ERROS/CASOS ESPECIAIS ===
        if (resultadoIA.tipo === 'imagem_duplicada') {
            await message.reply(resultadoIA.mensagem);
            return;
            
        } else if (resultadoIA.tipo === 'valor_nao_encontrado_na_tabela') {
            await message.reply(resultadoIA.mensagem);
            return;
            
        } else if (resultadoIA.tipo === 'dados_inconsistentes') {
            await message.reply(resultadoIA.mensagem);
            return;
            
        } else if (resultadoIA.tipo === 'numero_sem_comprovante') {
            await message.reply(
                `📱 *Número detectado*\n\n` +
                `❌ Não encontrei seu comprovante.\n\n` +
                `📝 Envie primeiro o comprovante de pagamento.`
            );
            return;
            
        } else if (resultadoIA.tipo === 'multiplos_numeros_nao_permitido') {
            console.log('🔄 IA detectou múltiplos números, redirecionando para bot de divisão...');
            
            const resultadoDivisaoTexto = await botDivisao.processarMensagem(
                message, 
                remetente, 
                message.from
            );
            
            if (resultadoDivisaoTexto && resultadoDivisaoTexto.resposta) {
                await message.reply(resultadoDivisaoTexto.resposta);
            } else {
                // Fallback para a mensagem original se o bot de divisão não processar
                await message.reply(
                    `📱 *${resultadoIA.numeros.length} números detectados*\n\n` +
                    `❌ Sistema atacado aceita apenas UM número por vez.\n\n` +
                    `📝 Envie apenas um número para receber o valor integral.`
                );
            }
            
            return;
        }

    } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error);
    }
});

// Variável para controlar reconexão
let reconnecting = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

client.on('disconnected', async (reason) => {
    console.log('❌ Bot atacado desconectado:', reason);
    
    if (!reconnecting && reconnectAttempts < maxReconnectAttempts) {
        reconnecting = true;
        reconnectAttempts++;
        
        console.log(`🔄 Tentando reconectar... (Tentativa ${reconnectAttempts}/${maxReconnectAttempts})`);
        
        setTimeout(async () => {
            try {
                await client.initialize();
                console.log('✅ Reconectado com sucesso!');
                reconnecting = false;
                reconnectAttempts = 0;
            } catch (error) {
                console.error('❌ Falha na reconexão:', error);
                reconnecting = false;
                
                if (reconnectAttempts >= maxReconnectAttempts) {
                    console.log('❌ Máximo de tentativas de reconexão atingido. Reinicialize manualmente.');
                }
            }
        }, 5000 * reconnectAttempts); // Delay progressivo
    }
});

// Evento para detectar quando a sessão é destruída
client.on('auth_failure', (message) => {
    console.error('❌ Falha na autenticação:', message);
    reconnectAttempts = 0; // Reset para permitir novas tentativas
});

// Capturar erros do Puppeteer
client.on('change_state', (state) => {
    console.log('🔄 Estado do cliente mudou para:', state);
});

// Adicionar tratamento para erros de protocolo
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rejeitada:', reason);
    
    // Se for erro de contexto destruído, tentar reconectar
    if (reason && reason.message && reason.message.includes('Execution context was destroyed')) {
        console.log('🔄 Erro de contexto detectado, forçando reconexão...');
        if (!reconnecting) {
            client.emit('disconnected', 'Execution context destroyed');
        }
    }
});

// === INICIALIZAÇÃO ===
client.initialize();

// Salvar histórico a cada 5 minutos
setInterval(salvarHistorico, 5 * 60 * 1000);

// Limpar dados antigos do Tasker a cada hora
setInterval(() => {
    if (dadosParaTasker.length > 200) {
        dadosParaTasker = dadosParaTasker.slice(-100);
        console.log('🗑️ Dados antigos do Tasker atacado removidos');
    }
}, 60 * 60 * 1000);

// Limpar cache de grupos logados a cada 2 horas
setInterval(() => {
    gruposLogados.clear();
    console.log('🗑️ Cache de grupos detectados limpo');
}, 2 * 60 * 60 * 1000);

process.on('SIGINT', async () => {
    console.log('\n💾 Salvando antes de sair...');
    await salvarHistorico();
    
    // Salvar dados finais do Tasker
    if (dadosParaTasker.length > 0) {
        const dadosFinais = dadosParaTasker.map(d => d.dados).join('\n');
        await fs.writeFile('tasker_backup_final_atacado.txt', dadosFinais);
        console.log('💾 Backup final do Tasker atacado salvo!');
    }
    
    console.log('🧠 IA: ATIVA');
    console.log('📦 Sistema atacado: CÁLCULO AUTOMÁTICO DE MEGAS');
    console.log('📊 Google Sheets ATACADO: CONFIGURADO');
    console.log(`🔗 URL: ${GOOGLE_SHEETS_CONFIG_ATACADO.scriptUrl}`);
    console.log(ia.getStatus());
    process.exit(0);

});



