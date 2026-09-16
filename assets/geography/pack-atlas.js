/* Artistic map coordinates refer to the owner's approved 1774 × 887 backdrop.
 * People and wolf counts come only from ALL_MEMBERS, never from a second roster.
 */
(function(root){
  "use strict";
  const WIDTH=1774, HEIGHT=887;
  const locations={
    "Мурманск":{point:[350,107],label:[377,103]},
    "Мончегорск":{point:[344,154],label:[319,158],align:"end"},
    "Чупа":{point:[342,216],label:[315,218],align:"end"},
    "Северодвинск":{point:[448,277],label:[471,260]},
    "Мелиоративный":{point:[337,363],label:[307,329],align:"end"},
    "Петрозаводск":{point:[339,377],label:[371,396]},
    "Ухта":{point:[637,333],label:[612,349],align:"end"},
    "Сосногорск":{point:[649,325],label:[678,318]},
    "Кострома":{point:[443,479],label:[471,463]},
    "Зеленоград":{point:[390,536],label:[363,529],align:"end"},
    "Долгопрудный":{point:[402,548],label:[443,526]},
    "Москва":{point:[408,567],label:[436,597]},
    "Воронеж":{point:[388,633],label:[358,657],align:"end"},
    "Оренбург":{point:[642,658],label:[671,663]}
  };
  function buildCities(members,registry=locations){
    const grouped=new Map();
    const names=new Set();
    for(const member of members){
      if(member.join) continue;
      if(names.has(member.name)) throw new Error(`Duplicate map member: ${member.name}`);
      names.add(member.name);
      const city=String(member.city||"").trim();
      const location=registry[city]||member.mapLocation;
      if(!city||!location) throw new Error(`Missing verified map city: ${member.name} (${city})`);
      for(const key of ["point","label"]){
        const p=location[key];
        if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>WIDTH||p[1]<0||p[1]>HEIGHT){
          throw new Error(`Invalid ${key} for ${city}`);
        }
      }
      if(!grouped.has(city)) grouped.set(city,{city,...location,members:[]});
      grouped.get(city).members.push(member);
    }
    return [...grouped.values()];
  }
  const svgNode=(tag,attrs={},text)=>{
    const node=document.createElementNS("http://www.w3.org/2000/svg",tag);
    for(const [name,value] of Object.entries(attrs))node.setAttribute(name,String(value));
    if(text!==undefined)node.textContent=text;
    return node;
  };
  function render({members,onCity}){
    const layer=document.getElementById("atlasCities");
    if(!layer)return;
    const cities=buildCities(members);
    layer.replaceChildren();
    cities.forEach((entry,index)=>{
      const [x,y]=entry.point,[lx,ly]=entry.label;
      const end=entry.align==="end";
      const names=entry.members.map(m=>m.name);
      const group=svgNode("g",{class:"atlas-city",tabindex:"0",role:"button","aria-haspopup":"dialog","aria-label":`${entry.city}: ${names.join(", ")}`,"data-city":entry.city,"data-count":names.length});
      group.append(svgNode("title",{},`${entry.city}: ${names.join(", ")}`));
      group.append(svgNode("path",{d:`M${x} ${y} L${lx+(end?8:-8)} ${ly-7}`,class:"atlas-tether"}));
      const light=svgNode("g",{class:"atlas-beacon",style:`--pulse-delay:${-index*.17}s`});
      light.append(svgNode("circle",{cx:x,cy:y,r:10,class:"atlas-glow"}),svgNode("circle",{cx:x,cy:y,r:4,class:"atlas-dot"}));
      group.append(light);
      group.append(svgNode("circle",{cx:x,cy:y,r:21,fill:"transparent"}));
      const labelWidth=Math.max(entry.city.length*14,entry.members.length*48);
      group.append(svgNode("rect",{x:end?lx-labelWidth-6:lx-6,y:ly-28,width:labelWidth+12,height:72,rx:8,fill:"transparent"}));
      group.append(svgNode("text",{x:lx,y:ly,class:"atlas-label","text-anchor":end?"end":"start"},entry.city));
      const widths=entry.members.map(m=>m.alpha?62:45);
      const rowWidth=widths.reduce((s,w)=>s+w,0)+Math.max(0,names.length-1)*3;
      let wolfX=end?lx-rowWidth:lx;
      entry.members.forEach((member,i)=>{
        group.append(svgNode("image",{
          class:`atlas-wolf${member.alpha?" atlas-wolf-leader":""}`,
          href:"assets/geography/wolf-user-silhouette.png",
          x:wolfX,y:ly+5,width:widths[i],height:member.alpha?42:31,
          "aria-hidden":"true","data-member":member.name
        }));
        wolfX+=widths[i]+3;
      });
      const activate=()=>onCity(entry.city,entry.members);
      group.addEventListener("click",activate);
      group.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate();}});
      layer.append(group);
    });
    const atlas=document.getElementById("packAtlas");
    atlas.setAttribute("aria-label",`Карта стаи: ${members.filter(m=>!m.join).length} участников. Нажмите город; карту можно сдвигать по горизонтали.`);
    // Start with all currently occupied western cities in view on phones.
    // The full map and Siberian logo remain in the same horizontally scrollable scene.
    if(atlas.scrollWidth>atlas.clientWidth)atlas.scrollLeft=32;
    return cities;
  }
  root.VargiAtlas={buildCities,render,locations};
})(typeof window!=="undefined"?window:globalThis);
