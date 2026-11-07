/* Local crops reuse each room's texture; these effects add no image resources. */
(function () {
  'use strict';
  const objects = {
    room: [
      ['shelf-plant-left','leaves',18,15,11,10],['shelf-plant-right','leaves',28,16,10,9],
      ['shelf-plant-small','leaves',31,33,6,6],['floor-plant-left','leaves',5,69,12,13],
      ['floor-plant-right','leaves',74,57,21,19],['desk-lamp','light',12,50,7,8],
      ['standing-lamp','light',74,29,8,10],['string-lights','light',82,20,13,32],
      ['window','sky',39,13,22,38],['monitor','screen',17,48,6,9],
      ['desk-cup-front','steam',15,57,5,7],['desk-cup-back','steam',25,48,4,6],
      ['bookshelf','touch',19,26,19,36],['wall-art-left','touch',6,28,7,20],
      ['wall-art-top','touch',66,19,9,12],['wall-art-bottom','touch',63,32,9,12],
      ['armchair-and-blanket','touch',57,45,28,30],['desk','touch',5,54,27,28],['rug','touch',29,66,42,23],
    ],
    room2: [
      ['hanging-plant-left','leaves',14,13,14,16],['hanging-plant-right','leaves',69,12,16,16],
      ['shelf-plant-top','leaves',7,28,9,13],['shelf-plant-middle','leaves',15,36,6,8],
      ['shelf-trailing-plant','leaves',21,38,10,18],['desk-plant','leaves',4,67,8,7],
      ['floor-plant-left','leaves',3,75,13,15],['window-plant','leaves',29,54,13,15],
      ['tall-plant','leaves',61,37,14,25],['floor-plant-right','leaves',83,79,15,12],
      ['floor-lamp','light',87,58,10,16],['string-lights','light',15,7,68,6],
      ['window','sky',31,15,38,55],['monitor','screen',10,63,5,8],
      ['desk-cup-front','steam',13,66,3,7],['desk-cup-back','steam',17,58,3,7],
      ['books-and-shelves','touch',16,48,11,15],['shelf-jars','touch',6,38,8,8],
      ['wall-art-left','touch',16,27,11,14],['wall-art-right','touch',75,29,21,31],
      ['hanging-chair-and-blanket','touch',69,44,20,39],['desk','touch',4,67,18,16],['rug','touch',28,72,44,23],
    ],
  };
  const layer = document.createElement('div');
  layer.id = 'room-details';
  layer.setAttribute('aria-hidden','true');
  const stage = document.getElementById('stage');
  const scene = document.getElementById('scene') || stage;
  scene.insertBefore(layer, document.getElementById('bg-night').nextSibling);
  let theme;
  function setTheme(next) {
    if (theme === next) return;
    theme = next;
    layer.replaceChildren();
    for (const [index,[name,effect,x,y,width,height]] of objects[theme].entries()) {
      const item = document.createElement('span');
      item.className = 'room-detail detail-' + effect;
      item.dataset.object = name;
      Object.assign(item.style,{left:x+'%',top:y+'%',width:width+'%',height:height+'%',animationDelay:(-index*1.7)+'s',animationDuration:(effect === 'steam' ? 4+index%3 : 7+index%5)+'s'});
      if (effect === 'leaves' || effect === 'touch') {
        item.style.backgroundImage = "url('/assets/visuals/soft-ink-v1/"+(theme === 'room2' ? 'sunroom' : 'room')+".webp')";
        item.style.backgroundSize = (10000/width)+'% '+(10000/height)+'%';
        item.style.backgroundPosition = (x/(100-width)*100)+'% '+(y/(100-height)*100)+'%';
      }
      layer.append(item);
    }
  }
  // Furniture responds to attention; decoration never intercepts controls.
  function attention(event) {
    if (!window.LisaMotion.active()) return;
    const bounds=layer.getBoundingClientRect();
    const x=(event.clientX-bounds.left)/bounds.width*100,y=(event.clientY-bounds.top)/bounds.height*100;
    for (const item of layer.querySelectorAll('.detail-touch')) {
      const left=parseFloat(item.style.left),top=parseFloat(item.style.top);
      item.classList.toggle('noticed',x>=left && x<=left+parseFloat(item.style.width) && y>=top && y<=top+parseFloat(item.style.height));
    }
  }
  const clear = () => layer.querySelectorAll('.noticed').forEach(item => item.classList.remove('noticed'));
  stage.addEventListener('pointermove',attention);
  stage.addEventListener('pointerdown',attention);
  stage.addEventListener('pointerleave',clear);
  stage.addEventListener('pointerup',clear);
  window.addEventListener('lisa-motion-change',() => { if (!window.LisaMotion.active()) clear(); });
  window.LisaRoomEffects = Object.freeze({setTheme,objects});
})();
