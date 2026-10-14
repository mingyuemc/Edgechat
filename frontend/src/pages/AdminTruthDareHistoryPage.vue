<script setup>
import { Download, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import api from '../api.js';
import UiButton from '../components/ui/Button.vue';
import UiSurface from '../components/ui/Surface.vue';
import { useI18n } from '../i18n.js';
import store from '../store.js';

const { locale, t } = useI18n();
const PAGE_SIZE = 50;

const loading = ref(false);
const exporting = ref(false);
const error = ref('');
const games = ref([]);
const rounds = ref([]);
const total = ref(0);
const offset = ref(0);

const isSuperAdmin = computed(() => Boolean(store.session?.isSuperAdmin));
const hasPrevious = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + rounds.value.length < total.value);
const currentPage = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

function formatDateTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale.value);
}

function choiceLabel(round) {
  if (!round.choice) return '';
  return t(round.choice === 'truth' ? 'truthDare.truth' : 'truthDare.dare');
}

async function loadHistory() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await api.adminTruthDareHistory(offset.value);
    games.value = payload.games || [];
    rounds.value = payload.rounds || [];
    total.value = Number(payload.total || 0);
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    loading.value = false;
  }
}

function changePage(delta) {
  const next = offset.value + delta * PAGE_SIZE;
  if (next < 0) return;
  offset.value = next;
  void loadHistory();
}

async function exportHistory() {
  exporting.value = true;
  error.value = '';
  try {
    const payload = await api.adminTruthDareHistoryExport();
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `truth-dare-history-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    exporting.value = false;
  }
}

onMounted(loadHistory);
</script>

<template>
  <div class="admin-section admin-truth-dare-history">
    <header class="admin-section__header">
      <div class="admin-section__heading">
        <h2>{{ t('truthDare.admin.historyTitle') }}</h2>
        <p>{{ t('truthDare.admin.historyDescription') }}</p>
      </div>
      <div class="inline-actions">
        <UiButton variant="secondary" :disabled="loading" @click="loadHistory">
          <RefreshCw :size="16" aria-hidden="true" :class="{ 'admin-spin': loading }" />
          {{ t('common.refresh') }}
        </UiButton>
        <UiButton variant="secondary" :disabled="exporting || !isSuperAdmin" @click="exportHistory">
          <Download :size="16" aria-hidden="true" />
          {{ exporting ? t('truthDare.admin.exporting') : t('truthDare.admin.export') }}
        </UiButton>
      </div>
    </header>

    <div class="admin-section__body">
      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="!isSuperAdmin" class="muted">{{ t('truthDare.admin.superOnly') }}</p>

      <template v-else>
        <UiSurface class="panel panel--table">
          <h3 class="panel-title">{{ t('truthDare.admin.gamesSection') }}</h3>
          <div class="admin-table-wrap">
            <table class="list-table">
              <thead>
                <tr>
                  <th>{{ t('truthDare.admin.columns.id') }}</th>
                  <th>{{ t('truthDare.admin.columns.title') }}</th>
                  <th>{{ t('truthDare.admin.columns.scope') }}</th>
                  <th>{{ t('truthDare.admin.columns.creator') }}</th>
                  <th>{{ t('truthDare.admin.columns.roundNo') }}</th>
                  <th>{{ t('truthDare.admin.columns.status') }}</th>
                  <th>{{ t('truthDare.admin.columns.createdAt') }}</th>
                  <th>{{ t('truthDare.admin.columns.endedAt') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading && !games.length"><td colspan="8" class="muted">{{ t('common.loading') }}</td></tr>
                <tr v-else-if="!games.length"><td colspan="8" class="muted">{{ t('truthDare.admin.empty') }}</td></tr>
                <tr v-for="game in games" :key="game.id">
                  <td>{{ game.id }}</td>
                  <td>
                    <strong>{{ game.title || t('truthDare.gameTitleFallback') }}</strong>
                  </td>
                  <td>{{ t(`truthDare.scope.${game.scope}`) }}</td>
                  <td>{{ game.creatorName || '-' }}</td>
                  <td>{{ game.roundCount }}</td>
                  <td>{{ t(`truthDare.status.${game.status}`) }}</td>
                  <td>{{ formatDateTime(game.createdAt) }}</td>
                  <td>{{ formatDateTime(game.endedAt) || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiSurface>

        <UiSurface class="panel panel--table">
          <div class="admin-truth-dare-history__rounds-head">
            <h3 class="panel-title">{{ t('truthDare.admin.roundsSection') }}</h3>
            <span class="muted">{{ t('truthDare.admin.total', { count: total }) }}</span>
          </div>
          <div class="admin-table-wrap">
            <table class="list-table">
              <thead>
                <tr>
                  <th>{{ t('truthDare.admin.columns.round') }}</th>
                  <th>{{ t('truthDare.admin.columns.gameId') }}</th>
                  <th>{{ t('truthDare.admin.columns.chosen') }}</th>
                  <th>{{ t('truthDare.admin.columns.choice') }}</th>
                  <th>{{ t('truthDare.admin.columns.prompt') }}</th>
                  <th>{{ t('truthDare.admin.columns.answer') }}</th>
                  <th>{{ t('truthDare.admin.columns.resolvedAt') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading && !rounds.length"><td colspan="7" class="muted">{{ t('common.loading') }}</td></tr>
                <tr v-else-if="!rounds.length"><td colspan="7" class="muted">{{ t('truthDare.admin.empty') }}</td></tr>
                <tr v-for="round in rounds" :key="round.id">
                  <td>{{ round.roundNo }}</td>
                  <td>
                    <strong>{{ round.gameTitle || t('truthDare.gameTitleFallback') }}</strong>
                    <div class="muted">#{{ round.gameId }}</div>
                  </td>
                  <td>{{ round.chosenName || '-' }}</td>
                  <td>{{ choiceLabel(round) || '-' }}</td>
                  <td>{{ round.promptContent || '-' }}</td>
                  <td>
                    <span v-if="round.answerText">{{ round.answerText }}</span>
                    <a v-else-if="round.answerVoiceUrl" :href="round.answerVoiceUrl" target="_blank" rel="noopener noreferrer">
                      {{ t('truthDare.answerVoiceLabel') }}
                    </a>
                    <span v-else>-</span>
                  </td>
                  <td>{{ formatDateTime(round.resolvedAt) || formatDateTime(round.createdAt) || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="inline-actions admin-truth-dare-history__pager">
            <UiButton variant="secondary" size="sm" :disabled="!hasPrevious || loading" @click="changePage(-1)">
              {{ t('truthDare.admin.previous') }}
            </UiButton>
            <span class="muted">{{ currentPage }} / {{ pageCount }}</span>
            <UiButton variant="secondary" size="sm" :disabled="!hasNext || loading" @click="changePage(1)">
              {{ t('truthDare.admin.next') }}
            </UiButton>
          </div>
        </UiSurface>
      </template>
    </div>
  </div>
</template>
