extends SceneTree
var failed := false
func _check(value: bool) -> void:
	if not value:
		failed = true
		push_error("Profile privacy regression")

const Profile = preload("res://scripts/player_profile.gd")
func _initialize() -> void:
	var fresh := ConfigFile.new()
	_check(Profile.migrate(fresh))
	_check(Profile.display_name(fresh) == "Guest")
	for name in ["Felix", " felix ", ""]:
		var legacy := ConfigFile.new()
		legacy.set_value("profile", "name", name)
		legacy.set_value("study", "days", {"2026-10-10": 1200})
		legacy.set_value("home", "style", {"wall": "sage"})
		legacy.set_value("connection", "token", "test-reconnect-token")
		legacy.set_value("hosting", "room_name", "Felix’s home")
		_check(Profile.migrate(legacy))
		_check(Profile.display_name(legacy) == "Guest")
		_check(legacy.get_value("study", "days")["2026-10-10"] == 1200)
		_check(legacy.get_value("home", "style")["wall"] == "sage")
		if not name.is_empty():
			_check(not legacy.has_section_key("connection", "token"))
			_check(legacy.get_value("hosting", "room_name") == "Guest’s home")
		legacy.set_value("profile", "name", "Felix")
		_check(not Profile.migrate(legacy))
		_check(Profile.display_name(legacy) == "Felix")
	var chosen := ConfigFile.new()
	chosen.set_value("profile", "name", "Maple")
	Profile.migrate(chosen)
	_check(Profile.display_name(chosen) == "Maple")
	if not failed:print("PROFILE_PRIVACY_PASS: neutral first launch, legacy default removed once, chosen names and study data preserved")
	quit(1 if failed else 0)
