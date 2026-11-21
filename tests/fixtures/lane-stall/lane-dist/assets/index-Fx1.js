var n=[];function t(e){let r=0;for(let o of n)r+=o*e;return r}function m(e){t(e/1e3)>1e9&&(n=[]),requestAnimationFrame(m)}var u=(e,r)=>e*r+t(1);export{u as onResize,m as renderFrame,t as stepSwarm};
//# sourceMappingURL=index-Fx1.js.map
