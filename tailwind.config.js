/** Сборка: npm run build:css  (готовый public/tailwind.css уже лежит в проекте) */
module.exports={
  darkMode:'media',
  content:['./public/index.html'],
  safelist:['a0','a1','a2','a3','sel','dim','enter','ok','bad','mut'],
  theme:{extend:{
    keyframes:{
      fadeUp:{'0%':{opacity:'0',transform:'translateY(14px)'},'100%':{opacity:'1',transform:'none'}},
      pop:{'0%':{transform:'scale(.6)'},'60%':{transform:'scale(1.14)'},'100%':{transform:'scale(1)'}},
      floaty:{'0%,100%':{transform:'translateY(0)'},'50%':{transform:'translateY(-6px)'}}
    },
    animation:{'fade-up':'fadeUp .45s ease both',pop:'pop .55s ease both',floaty:'floaty 3s ease-in-out infinite'}
  }},
  plugins:[]
}
