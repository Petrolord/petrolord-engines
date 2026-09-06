~Version
 VERS.                3.0 : CWLS LOG ASCII STANDARD - VERSION 3.0
 WRAP.                 NO : ONE LINE PER DEPTH STEP
 DLM.               COMMA : DELIMITING CHARACTER (SPACE TAB OR COMMA)
~Well
 STRT.M            1500.0000 : START DEPTH
 STOP.M            1504.5000 : STOP DEPTH
 STEP.M               0.5000 : STEP
 NULL.              -999.25  : NULL VALUE
 COMP.        PETROLORD TEST : COMPANY
 WELL.             KETA L3-2 : WELL
 FLD.                   KETA : FIELD
 UWI.             0123456790 : UNIQUE WELL ID
~Log_Definition
 DEPT.M                      : DEPTH {F}
 GR.GAPI                     : GAMMA RAY {F}
~Log_Data | Log_Definition
1500.0000,43.1351
1500.5000,42.4200
1501.0000,41.7804
1501.5000,41.2429
1502.0000,40.8328
1502.5000,40.5733
1503.0000,40.4850
1503.5000,40.5856
1504.0000,40.8896
1504.5000,41.4078
~Core_Parameter
 CORN.                     1 : CORE NUMBER {I}
~Core_Definition
 CORT.F                      : CORE TOP DEPTH {F}
 CORB.F                      : CORE BASE DEPTH {F}
 LITH.                       : LITHOLOGY {S}
 GSIZE.                      : GRAIN SIZE {S}
 DESC.                       : DESCRIPTION {S}
~Core_Data | Core_Definition
4921.26,4924.54,SST,F,"Fine sandstone, cross-bedded"
4924.54,4926.18,SH,CLY,"Grey shale, laminated"
4926.18,4929.46,"SST W/ SH STRINGERS",M,Sandstone with shale stringers
4930.00,4929.00,SST,M,bad row base above top
~Lithology_Definition
 LTOP.M                      : INTERVAL TOP {F}
 LBASE.M                     : INTERVAL BASE {F}
 ROCK.                       : ROCK TYPE {S}
 COLOR.                      : COLOUR {S}
~Lithology_Data | Lithology_Definition
1500.0,1501.5,LIMESTONE,grey
1501.5,1503.0,DOL,buff
1503.0,1504.5,MARBLE,white
~Tops_Definition
 TOPT.                       : TOP NAME {S}
 TOPD.M                      : TOP DEPTH {F}
~Tops_Data | Tops_Definition
"Top Sand A",1500.4
