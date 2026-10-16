<script setup>
import { onMounted, ref } from 'vue';
import AdminSiteAppearance from '../components/admin/AdminSiteAppearance.vue';
import AdminUpdateStatus from '../components/admin/AdminUpdateStatus.vue';
import UiButton from '../components/ui/Button.vue';
import UiSurface from '../components/ui/Surface.vue';
import api from '../api.js';
import { t } from '../i18n.js';
import { can } from '../authorization.ts';

const truthDareLoading = ref(false);
const truthDareSaving = ref(false);
const truthDareError = ref('');
const truthDareSaved = ref(false);
const allowMemberCreateGame = ref(false);
const canReadTruthDareSettings = can('truth_dare.read');
const canEditTruthDareSettings = can('truth_dare.settings.update');

const werewolfLoading = ref(false);
const werewolfSaving = ref(false);
const werewolfError = ref('');
const werewolfSaved = ref(false);
const allowMemberCreateWerewolf = ref(false);
const canReadWerewolfSettings = can('werewolf.read');
const canEditWerewolfSettings = can('werewolf.settings.update');

async function loadTruthDareSettings() {
  truthDareLoading.value = true;
  truthDareError.value = '';
  try {
    const payload = await api.adminTruthDareSettings();
    allowMemberCreateGame.value = Boolean(payload.allowMemberCreate);
  } catch (currentError) {
    truthDareError.value = currentError.message;
  } finally {
    truthDareLoading.value = false;
  }
}

async function saveTruthDareSettings() {
  truthDareSaving.value = true;
  truthDareError.value = '';
  truthDareSaved.value = false;
  try {
    const payload = await api.saveAdminTruthDareSettings(allowMemberCreateGame.value);
    allowMemberCreateGame.value = Boolean(payload.allowMemberCreate);
    truthDareSaved.value = true;
  } catch (currentError) {
    truthDareError.value = currentError.message;
  } finally {
    truthDareSaving.value = false;
  }
}

async function loadWerewolfSettings() {
  werewolfLoading.value = true;
  werewolfError.value = '';
  try {
    const payload = await api.adminWerewolfSettings();
    allowMemberCreateWerewolf.value = Boolean(payload.allowMemberCreate);
  } catch (currentError) {
    werewolfError.value = currentError.message;
  } finally {
    werewolfLoading.value = false;
  }
}

async function saveWerewolfSettings() {
  werewolfSaving.value = true;
  werewolfError.value = '';
  werewolfSaved.value = false;
  try {
    const payload = await api.saveAdminWerewolfSettings(allowMemberCreateWerewolf.value);
    allowMemberCreateWerewolf.value = Boolean(payload.allowMemberCreate);
    werewolfSaved.value = true;
  } catch (currentError) {
    werewolfError.value = currentError.message;
  } finally {
    werewolfSaving.value = false;
  }
}

onMounted(() => {
  if (canReadTruthDareSettings) loadTruthDareSettings();
  if (canReadWerewolfSettings) loadWerewolfSettings();
});
</script>

<template>
  <div class="admin-section">
    <header class="admin-section__header">
      <div class="admin-section__heading">
        <h2>{{ t('site.title') }}</h2>
        <p>{{ t('site.description') }}</p>
      </div>
    </header>

    <div class="admin-section__body">
      <section id="site-appearance" class="admin-anchor-section">
        <AdminSiteAppearance />
      </section>
      <section id="truth-dare-settings" class="admin-anchor-section">
        <UiSurface class="panel">
          <div class="admin-site-appearance__heading">
            <div>
              <h3 class="panel-title">{{ t('truthDare.admin.settingsTitle') }}</h3>
              <p>{{ t('truthDare.admin.allowMemberCreateHint') }}</p>
            </div>
            <UiButton variant="secondary" size="sm" :disabled="truthDareLoading" @click="loadTruthDareSettings">
              {{ truthDareLoading ? `${t('common.loading')}...` : t('site.reload') }}
            </UiButton>
          </div>

          <p v-if="truthDareError" class="error-text">{{ truthDareError }}</p>
          <label class="field">
            <span>{{ t('truthDare.admin.allowMemberCreate') }}</span>
            <input
              type="checkbox"
              :checked="allowMemberCreateGame"
              :disabled="!canEditTruthDareSettings || truthDareLoading"
              @change="allowMemberCreateGame = $event.target.checked"
            />
          </label>
          <div v-if="canEditTruthDareSettings" class="inline-actions">
            <UiButton :disabled="truthDareSaving || truthDareLoading" @click="saveTruthDareSettings">
              {{ truthDareSaving ? t('common.saving') : t('site.save') }}
            </UiButton>
            <span v-if="truthDareSaved" class="muted">{{ t('truthDare.admin.saved') }}</span>
          </div>
        </UiSurface>
      </section>
      <section id="werewolf-settings" class="admin-anchor-section">
        <UiSurface class="panel">
          <div class="admin-site-appearance__heading">
            <div>
              <h3 class="panel-title">{{ t('werewolf.admin.settingsTitle') }}</h3>
              <p>{{ t('werewolf.admin.allowMemberCreateHint') }}</p>
            </div>
            <UiButton variant="secondary" size="sm" :disabled="werewolfLoading" @click="loadWerewolfSettings">
              {{ werewolfLoading ? `${t('common.loading')}...` : t('site.reload') }}
            </UiButton>
          </div>

          <p v-if="werewolfError" class="error-text">{{ werewolfError }}</p>
          <label class="field">
            <span>{{ t('werewolf.admin.allowMemberCreate') }}</span>
            <input
              type="checkbox"
              :checked="allowMemberCreateWerewolf"
              :disabled="!canEditWerewolfSettings || werewolfLoading"
              @change="allowMemberCreateWerewolf = $event.target.checked"
            />
          </label>
          <div v-if="canEditWerewolfSettings" class="inline-actions">
            <UiButton :disabled="werewolfSaving || werewolfLoading" @click="saveWerewolfSettings">
              {{ werewolfSaving ? t('common.saving') : t('site.save') }}
            </UiButton>
            <span v-if="werewolfSaved" class="muted">{{ t('werewolf.admin.saved') }}</span>
          </div>
        </UiSurface>
      </section>
      <section id="version-update" class="admin-anchor-section">
        <AdminUpdateStatus />
      </section>
    </div>
  </div>
</template>
