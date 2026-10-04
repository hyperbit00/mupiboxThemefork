<?php
// Theme editor API (admin interface, "MuPiBox settings" -> Theme -> "Customize this theme").
//
// The master theme (/home/dietpi/MuPiBox/themes/<theme>.css) is NEVER changed. Changes are kept as an override:
//   themes/<theme>.user.json   the editor's model (colours and per-element rules)
//   themes/<theme>.user.css    the CSS made from that model (loaded after the master by the box display)
//   themes/_backup/<theme>/<YYYYmmdd-HHMMSS>[-note].json   a backup of the override before EVERY change (the note is the one
//                                                           that was typed when that version was saved)
// "Restore master" removes the override (the state before is backed up first, so it can be undone too).
//
// GET  ?action=load&theme=<id>          master css, current override, list of backups
// GET  ?action=list&theme=<id>          list of backups
// POST action=save&theme=<id>&model=<json>[&label=<text>]
// POST action=reset&theme=<id>          back to the master theme
// POST action=restore&theme=<id>&id=<backup id>
// (POST needs the csrf_token of the admin session)

$AUTH_CHECK_NO_TOUCH = false;
require __DIR__ . '/includes/auth_check.php';   // 401 for anybody not signed in; closes the session again
require __DIR__ . '/includes/csrf.php';
csrf_check();                                    // POST: 403 without the right token

const THEME_DIR     = '/home/dietpi/MuPiBox/themes';
const BACKUP_DIR    = THEME_DIR . '/_backup';
const WWW_DIR       = '/home/dietpi/.mupibox/Sonos-Kids-Controller-master/www';
const MAX_BACKUPS   = 40;
const MAX_RULES     = 300;
const MAX_VARS      = 200;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(array $data, int $code = 200): void {
	http_response_code($code);
	echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
	exit;
}
function fail(string $msg, int $code = 400): void {
	out(['ok' => false, 'error' => $msg], $code);
}

// ---------------------------------------------------------------- validation

function valid_theme(string $theme): string {
	if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $theme) || !is_file(THEME_DIR . '/' . $theme . '.css')) {
		fail('Unknown theme.');
	}
	return $theme;
}

// CSS properties the editor may set (plus custom properties --xyz)
const ALLOWED_PROPS = [
	'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
	'color', 'opacity', 'visibility', 'display',
	'border', 'border-width', 'border-style', 'border-color', 'border-radius', 'outline',
	'box-shadow', 'text-shadow', 'filter', 'backdrop-filter',
	'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
	'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
	'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'top', 'right', 'bottom', 'left', 'gap', 'z-index',
	'translate', 'scale', 'rotate', 'transform',
	'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-align', 'text-transform',
	'object-fit', 'overflow',
];

function clean_value($v): ?string {
	if (!is_string($v)) return null;
	$v = trim($v);
	if ($v === '' || strlen($v) > 300) return null;
	// nothing that could leave the declaration, open a comment or load something from elsewhere
	if (preg_match('/[{};<>\\\\@]|\/\*|\*\/|expression\s*\(|javascript:|!important/i', $v)) return null;
	if (preg_match_all('/url\s*\(([^)]*)\)/i', $v, $m)) {
		foreach ($m[1] as $u) {
			if (!preg_match('#^\s*["\']?/theme-data/[A-Za-z0-9_./-]+["\']?\s*$#', $u) || strpos($u, '..') !== false) return null;
		}
	}
	if (preg_match('/@import|\bhttps?:/i', $v)) return null;
	return $v;
}

function clean_selector($s): ?string {
	if (!is_string($s)) return null;
	$s = trim($s);
	if ($s === '' || strlen($s) > 300) return null;
	if (!preg_match('/^[A-Za-z0-9_\-\.\#\s>\+~:\(\)\[\]=\"\'\*\^\$\|]+$/', $s)) return null;   // no , { } ; \ / @ < >
	return preg_replace('/\s+/', ' ', $s);
}

// the model as the editor keeps it: { vars: {"--km-night": "#112233"}, rules: [ {sel: ".x .y", props: {"border-radius": "20px"}} ] }
function clean_model($model): array {
	if (!is_array($model)) fail('Invalid model.');
	$vars = [];
	foreach ((is_array($model['vars'] ?? null) ? $model['vars'] : []) as $k => $v) {
		if (!is_string($k) || !preg_match('/^--[A-Za-z0-9_-]{1,60}$/', $k)) continue;
		$cv = clean_value($v);
		if ($cv !== null) $vars[$k] = $cv;
		if (count($vars) >= MAX_VARS) break;
	}
	$rules = [];
	foreach ((is_array($model['rules'] ?? null) ? $model['rules'] : []) as $r) {
		if (!is_array($r)) continue;
		$sel = clean_selector($r['sel'] ?? null);
		if ($sel === null || !is_array($r['props'] ?? null)) continue;
		$props = [];
		foreach ($r['props'] as $p => $v) {
			if (!is_string($p)) continue;
			$p = strtolower($p);
			if (!in_array($p, ALLOWED_PROPS, true) && !preg_match('/^--[a-z0-9-]{1,60}$/', $p)) continue;
			$cv = clean_value($v);
			if ($cv !== null) $props[$p] = $cv;
		}
		if ($props) $rules[] = ['sel' => $sel, 'props' => $props];
		if (count($rules) >= MAX_RULES) break;
	}
	return ['vars' => (object)$vars, 'rules' => $rules];
}

// ---------------------------------------------------------------- css from the model

function selector_prefixed(string $sel): string {
	// stronger than the master theme's own selectors (they often use !important): five times :root = (0,5,0)
	if (preg_match('/^(html|body|:root)\b/', $sel)) return $sel;
	return ':root:root:root:root:root ' . $sel;
}

function model_to_css(array $model, string $theme): string {
	$css  = "/* MuPiBox theme editor: changes to the theme \"$theme\".\n";
	$css .= "   Generated - the master theme $theme.css is untouched. Delete this file (or use \"Restore master\" in the admin interface) to go back. */\n";
	$vars = (array)$model['vars'];
	if ($vars) {
		$css .= ":root, body, body[class*=\"km-theme-\"] {\n";
		foreach ($vars as $k => $v) $css .= "  $k: $v !important;\n";
		$css .= "}\n";
	}
	foreach ($model['rules'] as $r) {
		$css .= selector_prefixed($r['sel']) . " {";
		foreach ($r['props'] as $p => $v) $css .= " $p: $v !important;";
		$css .= " }\n";
	}
	return $css;
}

// ---------------------------------------------------------------- files (the themes folder belongs to dietpi: written through sudo)

function sudo_write(string $dest, string $content): bool {
	$tmp = tempnam(sys_get_temp_dir(), 'mupitheme');
	if ($tmp === false || file_put_contents($tmp, $content) === false) return false;
	chmod($tmp, 0644);
	exec('sudo mkdir -p ' . escapeshellarg(dirname($dest)) . ' 2>&1');
	exec('sudo install -m 644 -o dietpi -g dietpi ' . escapeshellarg($tmp) . ' ' . escapeshellarg($dest) . ' 2>&1', $o, $rc);
	@unlink($tmp);
	return $rc === 0;
}
function sudo_rm(string $file): void {
	if (is_file($file)) exec('sudo rm -f ' . escapeshellarg($file) . ' 2>&1');
}

function backup_dir(string $theme): string { return BACKUP_DIR . '/' . $theme; }

function backups(string $theme): array {
	$list = [];
	foreach (glob(backup_dir($theme) . '/*.json') ?: [] as $f) {
		$id = basename($f, '.json');
		if (!preg_match('/^(\d{8})-(\d{6})(?:-([a-z0-9_-]{1,30}))?$/', $id, $m)) continue;
		$ts = DateTime::createFromFormat('Ymd-His', $m[1] . '-' . $m[2]);
		$model = json_decode((string)@file_get_contents($f), true);
		$list[] = [
			'id'     => $id,
			'time'   => $ts ? $ts->format('Y-m-d H:i:s') : $id,
			'label'  => $m[3] ?? '',
			'vars'   => is_array($model['vars'] ?? null) ? count($model['vars']) : 0,
			'rules'  => is_array($model['rules'] ?? null) ? count($model['rules']) : 0,
		];
	}
	usort($list, fn($a, $b) => strcmp($b['id'], $a['id']));
	return $list;
}

// a backup of the current override (if there is one) - before every change
function clean_label($label): string {
	$label = strtolower(preg_replace('/[^a-z0-9_-]+/i', '-', (string)$label));
	return trim(substr($label, 0, 30), '-');
}
function make_backup(string $theme): void {
	$json = THEME_DIR . '/' . $theme . '.user.json';
	if (!is_file($json)) return;
	$label = clean_label((json_decode((string)file_get_contents($json), true)['label'] ?? ''));
	$id = date('Ymd-His') . ($label !== '' ? '-' . $label : '');
	$dest = backup_dir($theme) . '/' . $id . '.json';
	if (is_file($dest)) $dest = backup_dir($theme) . '/' . date('Ymd-His') . '-' . bin2hex(random_bytes(2)) . '.json';
	if (!sudo_write($dest, (string)file_get_contents($json))) fail('Could not write the backup - nothing was changed.', 500);
	// keep the newest ones
	$all = backups($theme);
	foreach (array_slice($all, MAX_BACKUPS) as $old) sudo_rm(backup_dir($theme) . '/' . $old['id'] . '.json');
}

// the box display takes the override from active_theme_user.css (linked by setting_update.sh); a changed override is
// shown after the display page has been loaded again
function apply_to_box(string $theme): void {
	$cfg = json_decode((string)@file_get_contents('/etc/mupibox/mupiboxconfig.json'), true);
	if (($cfg['mupibox']['theme'] ?? '') !== $theme) return;      // another theme than the one in use: nothing to apply
	exec('sudo /usr/local/bin/mupibox/setting_update.sh 2>&1');
	foreach ([(string)($cfg['chromium']['cachepath'] ?? ''), '/tmp/chromium_cache'] as $p) {
		$real = $p !== '' ? realpath($p) : false;
		if ($real !== false && is_dir($real) && ((strpos($real, '/home/dietpi/') === 0 && substr_count($real, '/') >= 3) || $real === '/tmp/chromium_cache')) {
			exec('sudo rm -R ' . escapeshellarg($real) . ' 2>&1');
		}
	}
	exec('sudo -i -u dietpi /usr/local/bin/mupibox/./restart_kiosk.sh 2>&1');
}

function write_override(string $theme, array $model, string $label = ''): void {
	$json = THEME_DIR . '/' . $theme . '.user.json';
	$css  = THEME_DIR . '/' . $theme . '.user.css';
	if (!$model['rules'] && !(array)$model['vars']) {            // nothing left: the same as the master theme
		sudo_rm($json);
		sudo_rm($css);
		return;
	}
	$stored = $label !== '' ? $model + ['label' => $label] : $model;
	if (!sudo_write($json, json_encode($stored, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES))
		|| !sudo_write($css, model_to_css($model, $theme))) {
		fail('Could not write the theme files.', 500);
	}
}

function current_model(string $theme): array {
	$m = json_decode((string)@file_get_contents(THEME_DIR . '/' . $theme . '.user.json'), true);
	return is_array($m) ? clean_model($m) : ['vars' => (object)[], 'rules' => []];
}

// ---------------------------------------------------------------- actions

$action = (string)($_REQUEST['action'] ?? '');
$method = $_SERVER['REQUEST_METHOD'];
$theme  = valid_theme((string)($_REQUEST['theme'] ?? ''));

if ($action === 'load' || $action === 'list') {
	if ($method !== 'GET') fail('Use GET.', 405);
	$res = ['ok' => true, 'theme' => $theme, 'backups' => backups($theme)];
	if ($action === 'load') {
		$res['masterCss'] = (string)file_get_contents(THEME_DIR . '/' . $theme . '.css');
		$res['model'] = current_model($theme);
		$res['hasOverride'] = is_file(THEME_DIR . '/' . $theme . '.user.json');
	}
	out($res);
}

if ($method !== 'POST') fail('Use POST.', 405);

if ($action === 'save') {
	$model = clean_model(json_decode((string)($_POST['model'] ?? ''), true));
	make_backup($theme);
	write_override($theme, $model, clean_label($_POST['label'] ?? ''));
	apply_to_box($theme);
	out(['ok' => true, 'backups' => backups($theme), 'css' => model_to_css($model, $theme), 'model' => $model]);
}

if ($action === 'reset') {
	make_backup($theme);
	write_override($theme, ['vars' => (object)[], 'rules' => []]);
	apply_to_box($theme);
	out(['ok' => true, 'backups' => backups($theme), 'model' => ['vars' => (object)[], 'rules' => []]]);
}

if ($action === 'restore') {
	$id = (string)($_POST['id'] ?? '');
	if (!preg_match('/^\d{8}-\d{6}(?:-[a-z0-9_-]{1,30})?$/', $id) || !is_file(backup_dir($theme) . '/' . $id . '.json')) fail('Unknown backup.');
	$stored = json_decode((string)file_get_contents(backup_dir($theme) . '/' . $id . '.json'), true);
	$model = clean_model($stored);
	make_backup($theme);
	write_override($theme, $model, clean_label($stored['label'] ?? ''));
	apply_to_box($theme);
	out(['ok' => true, 'backups' => backups($theme), 'css' => model_to_css($model, $theme), 'model' => $model]);
}

fail('Unknown action.');
