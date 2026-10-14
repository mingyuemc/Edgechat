import { Database, Gauge, Ghost, Link2, Send, Settings, Trophy, UserCog, UserPlus, Wrench } from '@lucide/vue';

export const adminNavigation = [
  { id: 'rbac', labelKey: 'rbac.title', descriptionKey: 'rbac.description', to: '/admin/rbac', icon: UserCog },
  { id: 'channels', labelKey: 'rbac.channels', descriptionKey: 'rbac.channelDescription', to: '/admin/channels', icon: UserCog },
  {
    id: 'dashboard',
    labelKey: 'admin.nav.dashboard',
    descriptionKey: 'admin.nav.dashboardDescription',
    to: '/admin/dashboard',
    icon: Gauge
  },
  {
    id: 'users',
    labelKey: 'admin.nav.users',
    descriptionKey: 'admin.nav.usersDescription',
    to: '/admin/users',
    icon: UserCog
  },
  {
    id: 'storage',
    labelKey: 'admin.nav.storage',
    descriptionKey: 'admin.nav.storageDescription',
    to: '/admin/storage',
    icon: Database
  },
  {
    id: 'invites',
    labelKey: 'admin.nav.invites',
    descriptionKey: 'admin.nav.invitesDescription',
    to: '/admin/invites',
    icon: UserPlus,
    children: [
      { id: 'create-user', labelKey: 'admin.nav.createUser', hash: '#create-user', permission: 'users.create' },
      { id: 'registration-links', labelKey: 'admin.nav.registrationLinks', hash: '#registration-links', permission: 'invites.read' }
    ]
  },
  {
    id: 'telegram',
    labelKey: 'admin.nav.telegram',
    descriptionKey: 'admin.nav.telegramDescription',
    to: '/admin/telegram',
    icon: Send
  },
  {
    id: 'site',
    labelKey: 'admin.nav.site',
    descriptionKey: 'admin.nav.siteDescription',
    to: '/admin/site',
    icon: Settings,
    children: [
      { id: 'site-appearance', labelKey: 'admin.nav.siteAppearance', hash: '#site-appearance' },
      { id: 'truth-dare-settings', labelKey: 'truthDare.admin.settingsTitle', hash: '#truth-dare-settings', permission: 'truth_dare.settings.update' },
      { id: 'version-update', labelKey: 'admin.nav.versionUpdate', hash: '#version-update' }
    ]
  },
  {
    id: 'instance-bridge',
    labelKey: 'bridge.title',
    descriptionKey: 'bridge.description',
    to: '/admin/instance-bridge',
    icon: Link2
  },
  {
    id: 'stealth',
    labelKey: 'stealth.title',
    descriptionKey: 'stealth.description',
    to: '/admin/stealth',
    icon: Ghost
  },
  {
    id: 'maintenance',
    labelKey: 'admin.nav.maintenance',
    descriptionKey: 'admin.nav.maintenanceDescription',
    to: '/admin/maintenance',
    icon: Wrench,
    separated: true
  },
  {
    id: 'truth-dare-history',
    labelKey: 'truthDare.admin.historyTitle',
    descriptionKey: 'truthDare.admin.historyDescription',
    to: '/admin/truth-dare-history',
    icon: Trophy
  }
];

export const adminRouteIcons = {
  dashboard: Gauge,
  users: UserCog,
  storage: Database,
  invites: UserPlus,
  telegram: Send,
  'instance-bridge': Link2,
  site: Settings,
  stealth: Ghost,
  maintenance: Wrench,
  'truth-dare': Trophy
};
