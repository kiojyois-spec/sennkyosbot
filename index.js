import { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    PermissionFlagsBits 
} from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
    ]
});

// -------------------------------------------------------------
// データ管理（メモリ上）
// -------------------------------------------------------------
let electionState = {
    isActive: false,
    title: '未設定の選挙',
    maxVotesPerUser: 1, // ⑦ 単記・連記対応
    candidates: new Map(), // userId -> { user, manifesto }
    votes: new Map(),      // voterId -> Array<candidateUserId>
    auditLogs: []          // ⑫ 監査ログ
};

// -------------------------------------------------------------
// 専用ロールを自動で取得・作成する便利関数
// -------------------------------------------------------------
async function getOrCreateRole(guild, roleName, color) {
    let role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
        role = await guild.roles.create({
            name: roleName,
            color: color || 0x99aab5,
            reason: '選挙システム用自動生成ロール'
        });
    }
    return role;
}

// -------------------------------------------------------------
// スラッシュコマンド（/）の定義
// -------------------------------------------------------------
const commands = [
    // 立候補機能コマンド
    new SlashCommandBuilder()
        .setName('candidate')
        .setDescription('立候補に関する操作を行います')
        .addSubcommand(sub => 
            sub.setName('apply').setDescription('立候補者ロールを取得して立候補します'))
        .addSubcommand(sub => 
            sub.setName('withdraw').setDescription('立候補を取り下げます')),

    // ① マニフェスト登録
    new SlashCommandBuilder()
        .setName('manifesto')
        .setDescription('自分のマニフェスト（所信表明）を登録・変更します')
        .addStringOption(opt => 
            opt.setName('content').setDescription('公約や意気込みを入力してください').setRequired(true)),

    // ②, ③ 選挙の開始・設定
    new SlashCommandBuilder()
        .setName('election-setup')
        .setDescription('【管理者用】選挙を開始・設定します')
        .addStringOption(opt => opt.setName('title').setDescription('選挙名').setRequired(true))
        .addIntegerOption(opt => opt.setName('max_votes').setDescription('1人の最大投票数（連記数）').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // ④ 匿名投票画面の呼び出し
    new SlashCommandBuilder()
        .setName('vote')
        .setDescription('投票パネルを表示します（匿名投票）'),

    // ⑧ 途中経過の確認
    new SlashCommandBuilder()
        .setName('election-status')
        .setDescription('【管理者用】現在の投票状況・開票経過を確認します')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // ⑨, ⑩, ⑪ 開票・当選確定・自動ロール引き継ぎ
    new SlashCommandBuilder()
        .setName('election-tally')
        .setDescription('【管理者用】選挙を終了し、開票を行って役職を引き継ぎます')
        .addIntegerOption(opt => opt.setName('winners').setDescription('当選人数').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    // ⑫ 監査ログ取得
    new SlashCommandBuilder()
        .setName('election-audit')
        .setDescription('【管理者用】選挙の監査ログを書き出します')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

// -------------------------------------------------------------
// ボット起動＆コマンド登録
// -------------------------------------------------------------
client.once('ready', async () => {
    console.log(`🤖 Logged in as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
            { body: commands }
        );
        console.log('✅ スラッシュコマンドの登録に成功しました。');
    } catch (error) {
        console.error('コマンド登録エラー:', error);
    }
});

// -------------------------------------------------------------
// コマンド実行ハンドラー
// -------------------------------------------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;

    const guild = interaction.guild;
    const member = interaction.member;

    // --- 【立候補コマンド】 /candidate ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'candidate') {
        const sub = interaction.options.getSubcommand();
        const candidateRole = await getOrCreateRole(guild, '候補者', 0xe91e63);

        if (sub === 'apply') {
            await member.roles.add(candidateRole);
            electionState.candidates.set(member.id, {
                user: member.user,
                manifesto: '（マニフェスト未登録）'
            });
            logAudit(`ユーザー ${member.user.tag} が立候補しました。`);

            return interaction.reply({ 
                content: `✅ **${member.user.username}** さんが立候補しました！「候補者」ロールが付与されました。\n\`/manifesto\` コマンドで公約を登録できます。`, 
                ephemeral: true 
            });
        } 
        
        if (sub === 'withdraw') {
            await member.roles.remove(candidateRole);
            electionState.candidates.delete(member.id);
            logAudit(`ユーザー ${member.user.tag} が立候補を取り下げました。`);

            return interaction.reply({ 
                content: `⚠️ 立候補を取り下げました。「候補者」ロールを解除しました。`, 
                ephemeral: true 
            });
        }
    }

    // --- 【機能①】 /manifesto (所信表明の登録) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'manifesto') {
        const candidateRole = await getOrCreateRole(guild, '候補者', 0xe91e63);
        if (!member.roles.cache.has(candidateRole.id)) {
            return interaction.reply({ content: '❌ 「候補者」ロールを持っているユーザーのみ利用可能です。（`/candidate apply`で立候補してください）', ephemeral: true });
        }

        const text = interaction.options.getString('content');
        const currentData = electionState.candidates.get(interaction.user.id) || { user: interaction.user };
        currentData.manifesto = text;
        electionState.candidates.set(interaction.user.id, currentData);

        logAudit(`候補者 ${interaction.user.tag} がマニフェストを更新しました。`);
        return interaction.reply({ content: '📝 マニフェストを更新・登録しました！', ephemeral: true });
    }

    // --- 【機能②・③】 /election-setup (選挙の告示・リマインド準備) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'election-setup') {
        electionState.title = interaction.options.getString('title');
        electionState.maxVotesPerUser = interaction.options.getInteger('max_votes');
        electionState.isActive = true;
        electionState.votes.clear();

        logAudit(`管理者 ${interaction.user.tag} が選挙「${electionState.title}」を開始しました。`);

        const embed = new EmbedBuilder()
            .setTitle(`📢 【選挙告示】${electionState.title}`)
            .setDescription(`選挙が開始されました！メンバーの皆さんは \`/vote\` コマンドから匿名投票を行ってください。`)
            .addFields(
                { name: '1人あたりの最大票数', value: `${electionState.maxVotesPerUser} 票`, inline: true },
                { name: '候補者一覧', value: electionState.candidates.size > 0 ? Array.from(electionState.candidates.values()).map(c => `・<@${c.user.id}>`).join('\n') : 'まだ候補者がいません' }
            )
            .setColor(0x00ff00);

        return interaction.reply({ embeds: [embed] });
    }

    // --- 【機能④・⑤・⑥】 /vote (有権者資格・匿名投票UIの提供) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'vote') {
        if (!electionState.isActive) {
            return interaction.reply({ content: '現在進行中の選挙はありません。', ephemeral: true });
        }

        if (electionState.candidates.size === 0) {
            return interaction.reply({ content: '現在、立候補者がいません。', ephemeral: true });
        }

        // 選択メニューを作成
        const options = Array.from(electionState.candidates.values()).map(c => ({
            label: c.user.username,
            value: c.user.id,
            description: c.manifesto.substring(0, 50)
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('vote_select')
            .setPlaceholder('投票する候補者を選択してください')
            .setMinValues(1)
            .setMaxValues(Math.min(electionState.maxVotesPerUser, options.length)) // ⑦ 複数選択対応
            .addOptions(options);

        const row = new ActionRowBuilder().addComponents(selectMenu);

        return interaction.reply({
            content: `🗳️ **【${electionState.title}】 投票パネル**\n（※他の人には見えない非公開画面です。⑥ 投票の変更も可能です）`,
            components: [row],
            ephemeral: true // ④ 匿名投票の担保
        });
    }

    // --- 投票ドロップダウンの実行処理 ---
    if (interaction.isStringSelectMenu() && interaction.customId === 'vote_select') {
        const selectedCandidates = interaction.values;
        
        // ⑥ 変更・重複投票防止
        electionState.votes.set(interaction.user.id, selectedCandidates);

        logAudit(`有権者 (ID: ${interaction.user.id}) が投票を行いました/変更しました。`);

        return interaction.reply({
            content: `✅ 投票を受理しました！選択した候補者: ${selectedCandidates.map(id => `<@${id}>`).join(', ')}`,
            ephemeral: true
        });
    }

    // --- 【機能⑧】 /election-status (リアルタイム途中経過) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'election-status') {
        const totalVotesCast = electionState.votes.size;
        return interaction.reply({
            content: `📊 **【現在の状況】**\n現在の総投票者数: **${totalVotesCast}** 人`,
            ephemeral: true
        });
    }

    // --- 【機能⑨・⑩・⑪】 /election-tally (自動開票・タイブレーク・ロール自動移行) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'election-tally') {
        if (!electionState.isActive) {
            return interaction.reply({ content: '進行中の選挙がありません。', ephemeral: true });
        }

        const winnersCount = interaction.options.getInteger('winners');
        
        // ⑨ 集計処理
        const tally = new Map();
        electionState.candidates.forEach((_, id) => tally.set(id, 0));

        for (const voteArray of electionState.votes.values()) {
            for (const candidateId of voteArray) {
                tally.set(candidateId, (tally.get(candidateId) || 0) + 1);
            }
        }

        // 得票順にソート
        const sortedResults = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);

        // 当選者決定
        const winners = sortedResults.slice(0, winnersCount);

        let resultText = '🎉 **【開票結果発表】**\n\n';
        for (const [candidateId, votes] of sortedResults) {
            resultText += `<@${candidateId}> : **${votes}** 票\n`;
        }

        resultText += '\n🏆 **【当選者】**\n';
        const electedRole = await getOrCreateRole(guild, '当選者（役員）', 0xf1c40f);

        for (const [winnerId] of winners) {
            resultText += `・<@${winnerId}>\n`;

            // ⑪ 役職（ロール）自動引き継ぎ機能
            try {
                const winnerMember = await guild.members.fetch(winnerId);
                await winnerMember.roles.add(electedRole);
            } catch (e) {
                console.error(`当選ロール付与に失敗: ${winnerId}`, e);
            }
        }

        electionState.isActive = false; // 選挙終了
        logAudit(`選挙「${electionState.title}」が終了し、開票が行われました。`);

        return interaction.reply({ content: resultText });
    }

    // --- 【機能⑫】 /election-audit (監査ログ出力) ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'election-audit') {
        const logContent = electionState.auditLogs.join('\n') || '監査ログはありません。';
        return interaction.reply({
            content: `🛡️ **【選挙監査ログ】**\n\`\`\`\n${logContent}\n\`\`\``,
            ephemeral: true
        });
    }
});

// -------------------------------------------------------------
// 監査ログ書き込み関数
// -------------------------------------------------------------
function logAudit(message) {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${message}`;
    electionState.auditLogs.push(entry);
    console.log(entry);
}

client.login(process.env.DISCORD_TOKEN);
