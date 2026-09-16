/* City positions are WGS84; people with no confirmed city are not assigned a point. */
(() => {
  const el = document.getElementById("packMap");
  if (!el) return;
  if (!window.L) {
    el.innerHTML = '<p class="pack-map-status">Карта временно недоступна. Обновите страницу, чтобы повторить загрузку.</p>';
    return;
  }
  const cities = [
    ["Мурманск",68.9707,33.0749,["Константин Нечаев","Дмитрий Меньшаков","Андрей Касьяненко"],"right"],
    ["Мончегорск",67.938,32.936,["Екатерина Бурянина"],"left"],
    ["Чупа",66.270,33.054,["Елена Богданова"],"left"],
    ["Северодвинск",64.5635,39.8302,["Василий Соснин"],"right"],
    ["Мелиоративный",61.92,34.23,["Лариса Иванова"],"left"],
    ["Петрозаводск",61.785,34.3469,["Павел Сарин","Алексей Кондратьев","Полина Сероносова"],"right"],
    ["Ухта",63.567,53.683,["Алексей Мошкин"],"left"],
    ["Сосногорск",63.599,53.881,["Людмила Удалова"],"right"],
    ["Зеленоград",55.9825,37.1814,["Максим Зубцов"],"left"],
    ["Москва",55.7558,37.6173,["Валерия Максименко"],"right"],
    ["Кострома",57.7679,40.9269,["Даниил Махов"],"right"],
    ["Воронеж",51.6608,39.2003,["Артём Грязев"],"left"],
    ["Оренбург",51.7682,55.0969,["Виталий Ильин"],"right"]
  ];
  el.replaceChildren();
  const map = L.map(el, {scrollWheelZoom:false, zoomSnap:0.1, minZoom:2, maxZoom:13, attributionControl:true});
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19,
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(map);
  const bounds = L.latLngBounds(cities.map(c => [c[1],c[2]]));
  const fit = () => map.fitBounds(bounds, {paddingTopLeft:[125,45],paddingBottomRight:[115,45],animate:false});
  fit();
  cities.forEach(([name,lat,lng,people,direction]) => {
    const marker = L.marker([lat,lng], {
      icon:L.divIcon({className:"pack-city-dot",html:"<span></span>",iconSize:[42,42],iconAnchor:[21,21]}),
      title:name, alt:name + ": " + people.join(", "), keyboard:true
    }).addTo(map);
    const label = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = name;
    label.appendChild(title);
    const wolves = document.createElement("div");
    wolves.className = "city-wolves";
    people.forEach(person => {
      const wolf = document.createElement("img");
      wolf.src = "assets/geography/wolf-standing-white.svg";
      wolf.alt = "";
      wolf.title = person;
      wolves.appendChild(wolf);
    });
    label.appendChild(wolves);
    marker.bindTooltip(label,{permanent:true,direction,offset:[direction==="left"?-8:8,0],className:"pack-city-label",opacity:1});
    const popup = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = name;
    popup.appendChild(heading);
    people.forEach(person => {const line=document.createElement("div");line.textContent=person;popup.appendChild(line);});
    marker.bindPopup(popup);
    marker.on("click",()=>{if(window.vargiTrack)window.vargiTrack("geography_region_click",{region:name});});
  });
  let previousWidth = el.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(previousWidth-el.clientWidth)<2) return;
    previousWidth=el.clientWidth;
    map.invalidateSize({pan:false});
    fit();
  }).observe(el);
})();
