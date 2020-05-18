async function createControls() {
	const div = document.createElement('div');
	div.classList.add('mess-roll-control');

	const advSelector = game.settings.get('mess', `${game.userId}.adv-selector`);
	const autoRollSelector = game.settings.get('mess', `${game.userId}.autoroll-selector`);
	const templateData = {
		advantage: advSelector === 'advantage',
		normal: advSelector ===  'normal',
		disadvantage: advSelector ===  'disadvantage',
		...autoRollSelector
	}

	div.insertAdjacentHTML('afterbegin', await renderTemplate('modules/mess/templates/roll-control.html', templateData));

	div.querySelectorAll('.mess-adv-selector a').forEach(e => {
		e.addEventListener('click', async function(ev) {
			ev.preventDefault();
			ev.stopPropagation();

			// if (ev.currentTarget.classList.contains('mess-selected')) return false;

			// ev.currentTarget.parentNode.querySelector('.mess-selected').classList.remove('mess-selected');
			// ev.currentTarget.classList.add('mess-selected');

			// game.settings.set('mess', `${game.userId}.adv-selector`, ev.currentTarget.name);
			const arr = Array.from(ev.currentTarget.parentNode.querySelectorAll('a'));
			const currIdx = arr.findIndex(e => e.classList.contains('mess-selected'));
			arr[currIdx].classList.remove('mess-selected');
			const newSelected = arr[(currIdx + 1) % arr.length];
			newSelected.classList.add('mess-selected');
			game.settings.set('mess', `${game.userId}.adv-selector`, newSelected.name);
		});
	});
	div.querySelectorAll('.mess-autoroll-selector a') .forEach(e => {
		e.addEventListener('click', async function(ev) {
			ev.preventDefault();
			ev.stopPropagation();

			
			ev.currentTarget.classList.toggle('mess-selected');
			let data = game.settings.get('mess', `${game.userId}.autoroll-selector`);
			data[ev.currentTarget.name] = ev.currentTarget.classList.contains('mess-selected');
			game.settings.set('mess', `${game.userId}.autoroll-selector`, data);
		})
	})
	return div;
}

// Only overwrite stuff for attack buttons
async function onChatCardAction (ev) {
	if (ev.currentTarget.dataset.action === 'attack')
		return renderAttack(ev);
	if (ev.currentTarget.dataset.action === 'damage')
		return renderAttack(ev);
	if (ev.currentTarget.dataset.placeTemplate)
		return renderTemplate(ev);

	return this._onChatCardAction(ev);		
}

async function getToHitData({actor, item}) {
	if (!item.hasAttack) return null;
	const actorData = actor.data.data;
	const itemData = item.data.data;
	const flags = actor.data.flags.dnd5e || {};
	
	let rollData = item.getRollData();

	// Define Roll bonuses
	const parts = [`@mod`];
	if ( (item.data.type !== "weapon") || itemData.proficient ) {
		parts.push("@prof");
	}
	rollData.parts = parts;
	// Attack Bonus
	const actorBonus = actorData.bonuses[itemData.actionType] || {};
	if ( itemData.attackBonus || actorBonus.attack ) {
		parts.push("@atk");
		rollData["atk"] = [itemData.attackBonus, actorBonus.attack].filterJoin(" + ");
	}

	// Expanded weapon critical threshold
	if (( item.data.type === "weapon" ) && flags.weaponCriticalThreshold) {
		rollData.critical = parseInt(flags.weaponCriticalThreshold);
	}

	// Elven Accuracy
	if ( ["weapon", "spell"].includes(item.data.type) ) {
		if (flags.elvenAccuracy && ["dex", "int", "wis", "cha"].includes(item.abilityMod)) {
			rollData.elvenAccuracy = true;
		}
	}

	// Apply Halfling Lucky
	if ( flags.halflingLucky ) rollData.halflingLucky = true;
	
	// rollData.formula = rollData.parts.join(" + ");
	const roll = new Roll(rollData.parts.join('+'), rollData);
	rollData.totalModifier = roll._safeEval(roll.formula);
	rollData.totalModifier = rollData.totalModifier >= 0 ? '+' + rollData.totalModifier : rollData.totalModifier;
	rollData.formula = roll.formula;
	rollData.terms = roll._formula;
	return rollData;
}

async function getDmgsData({actor, item, spellLevel = null}) {
	if (!item.hasDamage) return null;
	const actorData = actor.data.data;
	const itemData = item.data.data;
	let rollData = item.getRollData();
	
	if ( spellLevel ) rollData.item.level = spellLevel;

	rollData.parts = duplicate(itemData.damage.parts);
	if (itemData.damage.versatile) 
		rollData.parts.splice(1, 0, [itemData.damage.versatile, "versatile"]);
	
	if (item.data.type === 'spell') {
		if (itemData.scaling.mode === 'cantrip') {
			let newDmgPart = [rollData.parts[0][0]];
			const lvl = actor.data.type === 'character' ? actorData.details.level : actorData.details.spellLevel;
			item._scaleCantripDamage(newDmgPart, lvl, itemData.scaling.formula);
			rollData.parts[0][0] = newDmgPart[0];
		} else if (spellLevel && (itemData.scaling.mode === 'level') && itemData.scaling.formula ) {
			let newDmgPart = [];
			item._scaleSpellDamage(newDmgPart, itemData.level, spellLevel, itemData.scaling.formula)
			if (newDmgPart.length > 0) {
				newDmgPart.push('upcast dice');
				rollData.parts.push(newDmgPart);
			}
		}
	}
	
	const actorBonus = actorData.bonuses[itemData.actionType] || {};
	if (actorBonus.damage && parseInt(actorBonus.damage ) !== 0) {
		parts[0][0] += "+@dmg";
		rollData["dmg"] = actorBonus.damage;
	}

	for (let part of rollData.parts) {
		let roll = new Roll(part[0], rollData);
		const dmgType = CONFIG.DND5E.damageTypes[part[1]];
		if (dmgType)
			part[1] = game.i18n.localize('DND5E.Damage' + CONFIG.DND5E.damageTypes[part[1]]);
		else if (part[1] === 'versatile')
			part[1] = game.i18n.localize('DND5E.Versatile');
		part.push(roll.formula);
	}

	return rollData;
}

async function rollHit(ev) {
	// Extract card data
	const button = ev.currentTarget;
	button.disabled = true;
	const card = button.closest(".chat-card");
	const messageId = card.closest(".message").dataset.messageId;

	// Get the Actor from a synthetic Token
	const actor = CONFIG.Item.entityClass._getChatCardActor(card);
	if (!actor.owner) return false;

	// Get the Item
	const item = actor.getOwnedItem(card.dataset.itemId);
	if ( !item ) {
		return ui.notifications.error(`The requested item ${card.dataset.itemId} no longer exists on Actor ${actor.name}`)
	}

	let rollData = await getToHitData({actor, item});
	let adv = game.settings.get('mess', `${game.userId}.adv-selector`);
	// Determine the d20 roll and modifiers
	let nd = 1;
	let mods = rollData.halflingLucky ? "r=1" : "";

	// Handle advantage
	if ( adv === "advantage" ) {
		nd = rollData.elvenAccuracy ? 3 : 2;
		mods += "kh";
	}

	// Handle disadvantage
	else if ( adv === "disadvantage" ) {
		nd = 2;
		mods += "kl";
	}

	// Include the d20 roll
	rollData.parts.unshift(`${nd}d20${mods}`);

	let r = new Roll(rollData.parts.join('+'), rollData);
	r.roll();
	let div = document.createElement('div');
	div.title = `${rollData.parts[0]}+${rollData.terms} = ${r.formula} = ${r.total}. Click to see rolls.`;
	div.classList.add('dice-roll');
	div.classList.add('mess-dice-result');
	const span = div.appendChild(document.createElement('span'));
	span.innerText = r.total;
	div.insertAdjacentHTML('beforeend', await r.getTooltip());
	const tooltip = div.childNodes[1];
	tooltip.classList.add('hidden');
	const crit = rollData.critical || 20;
	const fumble = rollData.fumble || 1;

	const d20 = r.parts[0].total;
	if (d20 >= crit) {
		span.classList.add('crit');
		card.querySelector('.mess-chat-dmg .mess-chat-roll-type').innerHTML += ' - Crit!'
		card.querySelectorAll('.mess-button-dmg').forEach((e, idx) => {
			const formula = e.dataset.formula;
			const r = new Roll(formula);
			r.alter(0, 2);
			e.innerHTML = `<i class="fas fa-dice-d20"></i> ${r.formula}`
			e.dataset.formula = r.formula;
		});
	}
	if (d20 <= fumble)
		span.classList.add('fumble');

	ev.currentTarget.parentNode.replaceChild(div, ev.currentTarget);
	if (messageId) {
		const message = game.messages.get(messageId);
		message.update({content: card.parentNode.innerHTML});
	}
}

async function rollDmg(ev) {
	// Extract card data
	const button = ev.currentTarget;
	button.disabled = true;
	const card = button.closest(".chat-card");
	const messageId = card.closest(".message").dataset.messageId;
	const formula = button.dataset.formula;

	let r = new Roll(formula);
	r.roll();
	let div = document.createElement('div');
	div.title = `${button.dataset.terms} = ${r.formula} = ${r.total}. Click to see rolls.`;
	div.classList.add('dice-roll');
	div.classList.add('mess-dice-result');
	const span = div.appendChild(document.createElement('span'));
	span.innerText = r.total;
	div.insertAdjacentHTML('beforeend', await r.getTooltip());
	const tooltip = div.childNodes[1];
	tooltip.classList.add('hidden');

	ev.currentTarget.parentNode.replaceChild(div, ev.currentTarget);

	if (messageId) {
		const message = game.messages.get(messageId);
		message.update({content: card.parentNode.innerHTML});
	}
}

async function autoRoll(autoroll, template) {
	let card = document.createElement('div');
	card.classList.add('message');
	card.insertAdjacentHTML('afterbegin', template);
	if (autoroll.hit) {
		let toHitBtn = card.querySelector('.mess-button-to-hit');
		if (toHitBtn)
			await rollHit({currentTarget: toHitBtn});
	}

	if (autoroll.dmg) {
		const btns = Array.from(card.querySelectorAll('.mess-button-dmg'));
		for (const btn of btns)
			await rollDmg({currentTarget: btn});
	}
	return card.innerHTML;
}

async function renderAttack(ev) {
	if (ev.type === 'click') {
		ev.preventDefault();
		ev.stopPropagation();
	}

	// Extract card data
	const button = ev.currentTarget;
	button.disabled = true;
	const card = button.closest(".chat-card");

	// Get the Actor from a synthetic Token
	const actor = CONFIG.Item.entityClass._getChatCardActor(card);

	if ( !actor || !actor.owner) return;

	// Get the Item
	const item = actor.getOwnedItem(card.dataset.itemId);
	if ( !item ) {
		return ui.notifications.error(`The requested item ${card.dataset.itemId} no longer exists on Actor ${actor.name}`)
	}

	let targets = game.user.targets;
	// Don't roll for all targets if its an AoE, due to only rolling e.g. dmg once for all targets
	// TODO: Maybe add target list or chat cards for making saving throws
	// or not, since it would just spam the chatlog.. hmm
	const areaSkill = Object.keys(CONFIG.DND5E.areaTargetTypes).includes(getProperty(item, 'data.data.target.type'));
	if (!targets.size || areaSkill)
		targets =  [{data: {
				name: "someone",
				img: ""
			}
		}];
	const spellLevel = parseInt(card.dataset.spellLevel) || null;

	const template = 'modules/mess/templates/attack-card.html';

	const attackData = {
		actor, item,
		toHit: await getToHitData({actor, item}),
		dmgs: await getDmgsData({actor, item, spellLevel}),
		sceneId: canvas.scene.id
	}

	const autoroll = game.settings.get('mess', `${game.userId}.autoroll-selector`);

	for (const target of targets) {
		const attackTemplateData = {
									...attackData, 
									target: target.data,
									flavor: item.data.data.chatFlavor.replace(/\[target\.name\]/g, target.data.name)
								};
		let html = await renderTemplate(template, attackTemplateData);

		if (autoroll.hit || autoroll.dmg) 
			html = await autoRoll(autoroll, html);

		ChatMessage.create({
      user: game.user._id,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content: html,
      speaker: {
        actor: item.actor._id,
        token: item.actor.token,
        alias: item.actor.name
			}
		});
	}

	button.disabled = false;
}

async function getTargetToken(ev) {
	const card = ev.currentTarget.closest('.mess-attack-card');
	const sceneId = card.dataset.sceneId;
	if (sceneId !== canvas.scene.id) return false;
	const tokenId = card.dataset.targetId;
	if (!tokenId) return false;

	const token = canvas.tokens.placeables.find(e => e.id === tokenId);
	if (!token) return false;
	return token;
}

async function onMouseEnterTarget(ev) {
	ev.preventDefault();
	ev.stopPropagation();
	const token = await getTargetToken(ev);
	if (!token) return false;

	token._onHoverIn();
}

async function onMouseLeaveTarget(ev) {
	ev.preventDefault();
	ev.stopPropagation();
	const token = await getTargetToken(ev);
	if (!token || !token.visible) return false;
	
	token._onHoverOut();
}

async function onDblClickTarget(ev) {
	ev.preventDefault();
	ev.stopPropagation();
	const token = await getTargetToken(ev);
	if (!token || !token.visible) return false;
	
	const pos = token.center;
	canvas.animatePan({x: pos.x, y: pos.y})
}



function isTokenInside(token) {
	const grid = canvas.scene.data.grid,
				templatePos = {x: this.data.x, y: this.data.y};
	// Check for center of  each square the token uses.
	// e.g. for large tokens all 4 squares
	const startX = token.width >= 1 ? 0.5 : token.width / 2;
	const startY = token.height >= 1 ? 0.5 : token.height / 2;
	for (let x = startX; x < token.width; x++) {
		for (let y = startY; y < token.height; y++) {
			const currGrid = {
				x: token.x + x * grid - templatePos.x,
				y: token.y + y * grid - templatePos.y
			};
			const contains = this.shape.contains(currGrid.x, currGrid.y);
			if (contains) return true;
		}
	}
	return false;
}

function getTargets() {

	const tokens = canvas.scene.getEmbeddedCollection('Token');
	let targets = [];
	
	for (const token of tokens)
		if (this.isTokenInside(token)) { targets.push(token._id); }
	game.user.updateTokenTargets(targets);
}

async function changeAbilityTemplate() {
	const importedJS = (await import(/* webpackIgnore: true */ '/systems/dnd5e/module/pixi/ability-template.js'))
	const AbilityTemplate = importedJS.default || importedJS.AbilityTemplate;

	
	const _originalFromItem = AbilityTemplate.fromItem;
	AbilityTemplate.fromItem = function(item) {
		const template = _originalFromItem.bind(this)(item);
		
		// generate a texture based on the items dmg type, ...
		// Add settings to define custom templates for stuff.
		let path = item.getFlag('mess', 'templateTexture');
		if (!path && item.hasDamage) {
			const settings = game.settings.get('mess', 'templateTexture');
			path = settings[item.data.data.damage.parts[0][1]][template.data.t];
		}
		if (path)
			loadTexture(path).then(tex => {
				template.texture = tex;
				template.data.texture = path;
				template.refresh();
			})
		template.item = item;
		return template;
	}

	//  rather ugly, maybe find a better way at some point :shrug:
	const origPrevListeners = AbilityTemplate.prototype.activatePreviewListeners.toString();
	const newFun = origPrevListeners.replace(/this\.refresh\(\)\;/, 
				// get targets
					`this.refresh();
					this.getTargets(this);
				`);

	AbilityTemplate.prototype.getTargets = getTargets;
	AbilityTemplate.prototype.isTokenInside = isTokenInside;

	AbilityTemplate.prototype.activatePreviewListeners = Function(`"use strict"; return ( function ${newFun} )`)();
}

async function itemHook(app, html) {
	const div = document.createElement('div');
	div.classList.add('form-group');
	div.appendChild(document.createElement('label')).innerText = 'Template Texture';
	const formField = div.appendChild(document.createElement('div'));
	formField.classList.add('form-fields');
	const inp = formField.appendChild(document.createElement('input'));
	inp.dataset.dtype = 'String';
	inp.type = 'text';
	inp.name = 'flags.mess.templateTexture';
	inp.value = app.object.getFlag('mess', 'templateTexture') || "";

	formField.insertAdjacentHTML('beforeend', `
		<button type="button" class="file-picker" data-type="imagevideo" data-target="flags.mess.templateTexture" title="Browse Files" tabindex="-1">
			<i class="fas fa-file-import fa-fw"></i>
		</button>
	`);
	const button = formField.querySelector('button');
	button.style.flex = '0';
	app._activateFilePicker(button);
	html[0].querySelector('[name="data.target.units"]').closest('.form-group').after(div);
}


export default function modifyRolling() {
	game.settings.register('mess', `${game.userId}.adv-selector`, {
		name: 'Mess - Advantage Selector',
		default: 'normal',
		type: String,
		scope: 'user'
	});
	game.settings.register('mess', `${game.userId}.autoroll-selector`, {
		name: 'Mess - Autoroll Selector',
		default: {hit: false, dmg: false},
		type: Object,
		scope: 'user'
	});

	Hooks.on('renderChatLog', async (app, html, data) => {
		const div = await createControls();
		const controls = html[0].querySelector('#chat-controls');
		controls.insertBefore(div, controls.childNodes[0]);
	});

	// roundabout way to get the listener do what *I* want...
	// Since adding my own listener in renderChatLog was "to early".
	CONFIG.Item.entityClass.chatListeners = function (html) {
    html.on('click', '.card-buttons button', onChatCardAction.bind(this));
		html.on('click', '.item-name', this._onChatCardToggleContent.bind(this));
		
		// lets just use this for even more listeners
		html.on('mouseenter', '.mess-chat-target', onMouseEnterTarget);
		html.on('mouseleave', '.mess-chat-target', onMouseLeaveTarget);
		html.on('dblclick', '.mess-chat-target', onDblClickTarget);

		html.on('click', '.mess-button-to-hit', rollHit);
		html.on('click', '.mess-button-dmg', rollDmg);

		// delegate(html[0], {
		// 	target: '[data-tippy-content]'
		// });
	}

	Hooks.on('preCreateChatMessage', async (data) => {
		const div = document.createElement('div');
		div.insertAdjacentHTML('afterbegin',  data.content);
		let btn = div.querySelector('button[data-action="attack"]');
		if (!btn) {
			btn = div.querySelector('button[data-action="damage"]');
		}
		if (btn)
			renderAttack({currentTarget: btn});

	});

	Hooks.on('renderItemSheet', itemHook)

	changeAbilityTemplate();
}
